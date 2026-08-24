import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Search, Plus, X, Check, AlertTriangle, Trash2, Download, Upload,
  Pencil, RotateCcw, ShieldOff, ChevronLeft, Loader2
} from "lucide-react";
import { currentBackend } from "./storage-adapter.js";
import { devicesApi, notesApi, metaApi, ApiError } from "./api-client.js";

/* ══════════════════════════════════════════════════════════════
   DEVICE INDEX — central device registry
   Records device-identifying data only. No individual data.
   ══════════════════════════════════════════════════════════════ */

const STORE_KEY = "device-registry-v1";

// The api backend is resource-oriented, not a blob store: search is
// server-side and paged, actions hit their own endpoint, and roles decide
// what a given caller may do. Everything below that branches on IS_API talks
// to devicesApi/notesApi directly instead of through the local `store` blob.
const BACKEND = currentBackend();
const IS_API = BACKEND === "api";
const PAGE_SIZE = 50;

// Mirrors the CAN table in api/src/config.js — duplicated only so a control
// a caller's role cannot use is disabled instead of producing a 403. This is
// not the boundary; Postgres and the API are. See api/README.md.
const CAN_UI = {
  registerDevice: ["warehouse", "manager"],
  editIdentifiers: ["warehouse", "manager"],
  changeStatus: ["technician", "warehouse", "manager"],
  addNote: ["technician", "warehouse", "manager"],
  softDelete: ["manager"],
  export: ["manager"],
};
const roleCan = (cap, identity) => !IS_API || (!!identity && CAN_UI[cap].includes(identity.role));

const noteKindToApi = (k) => (k === "obs" ? "observation" : "repair");
const noteKindFromApi = (k) => (k === "observation" ? "obs" : "repair");
const readableAdvisory = (f) => String(f).replace(/^advisory:\s*/, "");

function describeApiError(e) {
  if (e instanceof ApiError) {
    if (e.status === 0) return e.message;
    if (e.status === 401) return "Not authenticated — reload the page.";
    return e.message || `The API rejected the request (${e.status}).`;
  }
  return e?.message || "Something went wrong talking to the API.";
}

// Server shape (see api/src/routes/devices.js `shape()`) to the shape this
// component already renders everywhere.
function fromApiDevice(d, notes) {
  return {
    id: d.id,
    serial: d.serial,
    type: d.deviceType,
    imei: d.imei || "",
    iccid: d.iccid || "",
    status: d.status,
    notes: notes ?? [],
    noteCount: d.noteCount,
    matchKind: d.matchKind,
    addedAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function fromApiNote(n) {
  return {
    id: n.id,
    body: n.body,
    kind: noteKindFromApi(n.kind),
    at: n.createdAt,
    advisoryFindings: n.advisoryFindings,
  };
}

const TYPES = [
  { id: "loop",       label: "Loop",       code: "LP" },
  { id: "loop_phone", label: "Loop Phone", code: "LPH" },
  { id: "101",        label: "101",        code: "101" },
  { id: "101a",       label: "101A",       code: "01A" },
  { id: "101pro",     label: "101 Pro",    code: "PRO" },
  { id: "extender",   label: "Extender",   code: "EXT" },
];
const typeOf = (id) => TYPES.find((t) => t.id === id) || { id, label: id || "—", code: "?" };

const STATUSES = [
  { id: "stock",    label: "In stock",  tone: "neutral" },
  { id: "deployed", label: "Deployed",  tone: "good" },
  { id: "repair",   label: "In repair", tone: "warn" },
  { id: "refurb",   label: "In refurb", tone: "refurb" },
  { id: "rma",      label: "RMA",       tone: "warn" },
  { id: "retired",  label: "Retired",   tone: "dead" },
];
const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];

const NOTE_KINDS = [
  { id: "repair", label: "Repair" },
  { id: "obs",    label: "Observation" },
];

/* ── identifier helpers ──────────────────────────────────────── */

const digits = (v) => String(v || "").replace(/\D/g, "");
const upper = (v) => String(v || "").trim().toUpperCase();

function luhnOk(d) {
  if (!/^\d{2,}$/.test(d)) return false;
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// IMEI prints as 2-6-6-1 (GSMA). ICCID reads off the SIM in fours.
const groupsFor = (kind, len) =>
  kind === "imei" && len === 15 ? [2, 6, 6, 1] : null;

function groupDigits(d, kind) {
  const g = groupsFor(kind, d.length);
  const out = [];
  if (g) {
    let i = 0;
    for (const n of g) { out.push(d.slice(i, i + n)); i += n; }
    if (i < d.length) out.push(d.slice(i));
  } else {
    for (let i = 0; i < d.length; i += 4) out.push(d.slice(i, i + 4));
  }
  return out.filter(Boolean);
}

/* ── personal-data screening ─────────────────────────────────── */
/* The schema has no name / owner / contact field by design. These
   patterns catch personal data typed into free text anyway. This is a
   usability feature only — the screening trigger in the database is the
   control (invariant 6), and the api backend below always defers to
   whatever the server actually decides, including cases this misses. */

const BLOCK_RULES = [
  { label: "an email address",     re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { label: "a national ID number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: "a date of birth",      re: /\b(d\.?o\.?b\.?|date of birth|born on)\b/i },
  {
    label: "a street address",
    re: /\b\d{1,5}\s+[a-z][a-z'.-]*\s*(?:[a-z'.-]+\s*)?\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way|close|crescent|cres|terrace|boulevard|blvd|place|pl)\b/i,
  },
];

const WARN_WORDS = [
  "customer name", "subscriber", "patient", "resident", "tenant", "client name",
  "account holder", "next of kin", "full name", "first name", "last name",
  "surname", "postcode", "post code", "zip code", "email", "phone number",
  "mobile number", "contact number", "guardian", "carer name",
];

function phoneLike(text) {
  // Dates, times and version strings are not phone numbers.
  const t = String(text || "")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  const hits = [];
  const re = /\+?\d[\d\s().-]{5,}\d/g;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[0];
    const d = digits(raw);
    const separated = /[\s().-]/.test(raw) || raw.startsWith("+");
    if (separated && d.length >= 7 && d.length <= 13) hits.push(raw.trim());
  }
  return hits;
}

function screen(text) {
  const t = String(text || "");
  const blocked = [], warned = [];
  if (!t.trim()) return { blocked, warned };
  for (const r of BLOCK_RULES) {
    const m = t.match(r.re);
    if (m) blocked.push({ label: r.label, sample: m[0].trim().slice(0, 40) });
  }
  for (const w of WARN_WORDS) {
    if (t.toLowerCase().includes(w)) { warned.push({ label: `the phrase “${w}”`, sample: w }); break; }
  }
  const ph = phoneLike(t);
  if (ph.length) warned.push({ label: "a phone number", sample: ph[0].slice(0, 24) });
  return { blocked, warned };
}

/* ── local storage (the `local` backend only) ───────────────────── */

const store = {
  async read() {
    if (!(typeof window !== "undefined" && window.storage)) return null;
    try {
      const r = await window.storage.get(STORE_KEY, false);
      if (!r || !r.value) return null;
      const p = JSON.parse(r.value);
      return Array.isArray(p?.devices) ? p.devices : null;
    } catch { return null; }
  },
  async write(devices) {
    if (!(typeof window !== "undefined" && window.storage)) return false;
    try {
      const r = await window.storage.set(
        STORE_KEY, JSON.stringify({ v: 1, devices }), false
      );
      return !!r;
    } catch { return false; }
  },
  async wipe() {
    if (!(typeof window !== "undefined" && window.storage)) return false;
    try { await window.storage.delete(STORE_KEY, false); return true; } catch { return false; }
  },
};

const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
};
const fmtDay = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  } catch { return iso; }
};

/* ══════════════════════════════════════════════════════════════
   Small presentational pieces
   ══════════════════════════════════════════════════════════════ */

function Mark({ text, query }) {
  const t = String(text || "");
  const q = upper(String(query || "").replace(/[^a-z0-9]/gi, ""));
  if (!q) return <>{t}</>;
  const flat = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const map = [];
  t.split("").forEach((ch, i) => { if (/[a-z0-9]/i.test(ch)) map.push(i); });
  const at = flat.indexOf(q);
  if (at < 0) return <>{t}</>;
  const s = map[at], e = map[at + q.length - 1];
  return (
    <>
      {t.slice(0, s)}
      <span className="hl">{t.slice(s, e + 1)}</span>
      {t.slice(e + 1)}
    </>
  );
}

function GroupedId({ value, kind, query }) {
  const d = digits(value);
  if (!d) return <span className="id-empty">not recorded</span>;
  const q = digits(query);
  const at = q ? d.indexOf(q) : -1;
  const end = at >= 0 ? at + q.length : -1;
  let i = 0;
  return (
    <span className="id-run">
      {groupDigits(d, kind).map((g, gi) => (
        <span className="id-grp" key={gi}>
          {g.split("").map((ch) => {
            const idx = i++;
            const on = at >= 0 && idx >= at && idx < end;
            return <span key={idx} className={on ? "hl" : undefined}>{ch}</span>;
          })}
        </span>
      ))}
    </span>
  );
}

function CheckDigit({ value, kind }) {
  const d = digits(value);
  if (kind === "imei" && d.length !== 15) return null;
  if (kind === "iccid" && (d.length < 18 || d.length > 20)) return null;
  const ok = luhnOk(d);
  return (
    <span className={`cd ${ok ? "cd-ok" : "cd-bad"}`} title={ok ? "Check digit valid" : "Check digit does not match — re-read the number"}>
      {ok ? <Check size={11} strokeWidth={3} /> : <AlertTriangle size={11} strokeWidth={2.6} />}
      {ok ? "check ok" : "check fails"}
    </span>
  );
}

const StatusChip = ({ id, small }) => {
  const s = statusOf(id);
  return <span className={`st st-${s.tone} ${small ? "st-sm" : ""}`}><i /> {s.label}</span>;
};

const TypeTag = ({ id }) => {
  const t = typeOf(id);
  return <span className="tt" title={t.label}>{t.code}</span>;
};

function Field({ label, hint, children, error, warn }) {
  return (
    <label className="fld">
      <span className="fld-l">{label}{hint && <em>{hint}</em>}</span>
      {children}
      {error && <span className="fld-e"><ShieldOff size={12} /> {error}</span>}
      {warn && !error && <span className="fld-w"><AlertTriangle size={12} /> {warn}</span>}
    </label>
  );
}

/* ══════════════════════════════════════════════════════════════
   Add / edit record
   ══════════════════════════════════════════════════════════════ */

function RecordForm({ initial, devices, onSave, onCancel, prefill, identity }) {
  const editing = !!initial;
  const pf = prefill || {};
  const [serial, setSerial] = useState(initial?.serial || pf.serial || "");
  const [type, setType] = useState(initial?.type || "");
  const [imei, setImei] = useState(initial?.imei || pf.imei || "");
  const [iccid, setIccid] = useState(initial?.iccid || pf.iccid || "");
  const [status, setStatus] = useState(initial?.status || "stock");
  const [firstNote, setFirstNote] = useState("");
  const [noteKind, setNoteKind] = useState("obs");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [advisoryFromServer, setAdvisoryFromServer] = useState(null);
  const [createdId, setCreatedId] = useState(null);
  const first = useRef(null);

  useEffect(() => { first.current?.focus(); }, []);

  // Under the api backend `devices` is only the current page of search
  // results, not the whole fleet, so this catches the common case fast but
  // is not authoritative — the server's own unique constraint is (D6/invariant 6).
  const others = devices.filter((d) => d.id !== initial?.id);
  const sn = upper(serial);
  const im = digits(imei);
  const ic = digits(iccid);

  const identifiersLocked = editing && !roleCan("editIdentifiers", identity);
  const serialLocked = IS_API && editing; // serials are immutable server-side

  const err = {};
  const warn = {};

  if (!sn) err.serial = "A serial number is required — it is the key for the record.";
  else if (sn.length < 3) err.serial = "Serial looks too short to be unique.";
  else if (others.some((d) => upper(d.serial) === sn)) err.serial = `Serial ${sn} is already in the index.`;

  if (im) {
    if (im.length !== 15) err.imei = `IMEI must be 15 digits — you entered ${im.length}.`;
    else {
      const clash = others.find((d) => digits(d.imei) === im);
      if (clash) err.imei = `IMEI already recorded against ${clash.serial}.`;
      else if (!luhnOk(im)) warn.imei = "Check digit does not match. Re-read the last digit.";
    }
  }
  if (ic) {
    if (ic.length < 18 || ic.length > 20) err.iccid = `ICCID must be 18–20 digits — you entered ${ic.length}.`;
    else {
      const clash = others.find((d) => digits(d.iccid) === ic);
      if (clash) err.iccid = `ICCID already recorded against ${clash.serial}.`;
      else if (!luhnOk(ic)) warn.iccid = "Check digit does not match. Re-read the number.";
    }
  }
  if (!type) err.type = "Pick the device type.";

  const scanned = screen(`${serial} ${firstNote}`);
  if (scanned.blocked.length) {
    err.pii = `Remove ${scanned.blocked.map((b) => b.label).join(" and ")} — this index holds device data only.`;
  }
  const advisoryLabels = advisoryFromServer
    ? advisoryFromServer.map(readableAdvisory)
    : scanned.warned.map((w) => w.label);
  const needsAck = !err.pii && (scanned.warned.length > 0 || !!advisoryFromServer);

  const blocked = Object.keys(err).length > 0 || (needsAck && !ack) || busy;

  const submitLocal = () => {
    const now = new Date().toISOString();
    const notes = initial?.notes ? [...initial.notes] : [];
    if (firstNote.trim()) notes.push({ id: uid("n"), body: firstNote.trim(), kind: noteKind, at: now });
    onSave({
      id: initial?.id || uid("dev"),
      serial: sn, type, imei: im, iccid: ic, status,
      notes,
      addedAt: initial?.addedAt || now,
      updatedAt: now,
    });
  };

  const submitApi = async () => {
    setBusy(true);
    setFormError(null);
    try {
      let deviceId = initial?.id || createdId;
      if (!deviceId) {
        const created = await devicesApi.create({
          serial: sn, deviceType: type, status,
          imei: im || undefined, iccid: ic || undefined,
        });
        deviceId = created.id;
        setCreatedId(deviceId);
      } else if (editing) {
        const patch = {};
        if (!identifiersLocked) {
          if (type !== initial.type) patch.deviceType = type;
          if (im !== (initial.imei || "")) patch.imei = im || null;
          if (ic !== (initial.iccid || "")) patch.iccid = ic || null;
        }
        if (status !== initial.status) patch.status = status;
        if (Object.keys(patch).length) await devicesApi.patch(deviceId, patch);
      }

      if (!editing && firstNote.trim()) {
        try {
          await notesApi.add(deviceId, {
            body: firstNote.trim(),
            kind: noteKindToApi(noteKind),
            acknowledgeAdvisory: !!advisoryFromServer && ack,
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.data?.code === "advisory_review_required") {
            // The device is already created — only the note is pending.
            // Let them acknowledge and press save again.
            setAdvisoryFromServer(e.data.findings || []);
            setBusy(false);
            return;
          }
          throw e;
        }
      }
      onSave({ id: deviceId });
    } catch (e) {
      setFormError(describeApiError(e));
      setBusy(false);
    }
  };

  const submit = () => {
    if (blocked) return;
    if (IS_API) submitApi();
    else submitLocal();
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={editing ? "Edit record" : "Add device"}>
      <div className="sheet-hd">
        <span className="lbl">{editing ? `Edit ${initial.serial}` : "Add device"}</span>
        <button className="icon-btn" onClick={onCancel} aria-label="Close"><X size={16} /></button>
      </div>

      <div className="sheet-bd">
        {formError && (
          <div className="banner banner-bad"><ShieldOff size={14} /> {formError}</div>
        )}

        <Field label="Serial number" hint={serialLocked ? "immutable" : "record key"} error={err.serial}>
          <input
            ref={first} className="in mono" value={serial} spellCheck={false} autoCapitalize="characters"
            onChange={(e) => setSerial(e.target.value)} placeholder="e.g. LP24A00317"
            readOnly={serialLocked}
          />
        </Field>

        <Field label="Device type" error={err.type} warn={identifiersLocked ? "your role cannot change this" : undefined}>
          <div className="chips">
            {TYPES.map((t) => (
              <button key={t.id} type="button" disabled={identifiersLocked}
                className={`chip ${type === t.id ? "chip-on" : ""}`}
                onClick={() => setType(t.id)}>{t.label}</button>
            ))}
          </div>
        </Field>

        <div className="row2">
          <Field label="IMEI" hint="15 digits, if fitted" error={err.imei} warn={warn.imei}>
            <input className="in mono" value={imei} inputMode="numeric" spellCheck={false} disabled={identifiersLocked}
              onChange={(e) => setImei(e.target.value)} placeholder="35 209900 176148 1" />
          </Field>
          <Field label="ICCID" hint="SIM, 18–20 digits" error={err.iccid} warn={warn.iccid}>
            <input className="in mono" value={iccid} inputMode="numeric" spellCheck={false} disabled={identifiersLocked}
              onChange={(e) => setIccid(e.target.value)} placeholder="8944 5500 1234 5678 901" />
          </Field>
        </div>

        <Field label="Status" warn={IS_API && !roleCan("changeStatus", identity) ? "your role cannot change this" : undefined}>
          <div className="chips">
            {STATUSES.map((s) => (
              <button key={s.id} type="button" disabled={IS_API && !roleCan("changeStatus", identity)}
                className={`chip ${status === s.id ? "chip-on" : ""}`}
                onClick={() => setStatus(s.id)}>{s.label}</button>
            ))}
          </div>
        </Field>

        {!editing && (
          <Field label="Opening note" hint="optional" error={err.pii}>
            <div className="chips chips-tight">
              {NOTE_KINDS.map((k) => (
                <button key={k.id} type="button"
                  className={`chip chip-sm ${noteKind === k.id ? "chip-on" : ""}`}
                  onClick={() => setNoteKind(k.id)}>{k.label}</button>
              ))}
            </div>
            <textarea className="in ta" rows={3} value={firstNote}
              onChange={(e) => setFirstNote(e.target.value)}
              placeholder="Condition on intake, fault seen, work done. Describe the device, not the person using it." />
          </Field>
        )}

        {editing && err.pii && <div className="banner banner-bad"><ShieldOff size={14} /> {err.pii}</div>}

        {needsAck && (
          <div className="banner banner-warn">
            <AlertTriangle size={14} />
            <div>
              <b>Possible personal data:</b> {advisoryLabels.join(", ")}.
              <label className="ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                This text contains no personal data.
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="sheet-ft">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-solid" disabled={blocked} onClick={submit}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add to index"}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Detail pane
   ══════════════════════════════════════════════════════════════ */

function NoteComposer({ onAdd, disabled }) {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("repair");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [serverAdvisory, setServerAdvisory] = useState(null);
  const sc = screen(body);
  const hard = sc.blocked.length > 0;
  const soft = !hard && (sc.warned.length > 0 || !!serverAdvisory);
  const can = !disabled && body.trim().length > 1 && !hard && (!soft || ack) && !busy;
  const advisoryLabels = serverAdvisory ? serverAdvisory.map(readableAdvisory) : sc.warned.map((w) => w.label);

  const submit = async () => {
    if (!can) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd({ body: body.trim(), kind, acknowledgeAdvisory: soft && ack });
      setBody(""); setAck(false); setServerAdvisory(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.code === "advisory_review_required") {
        setServerAdvisory(e.data.findings || []);
      } else {
        setError(describeApiError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <div className="chips chips-tight">
        {NOTE_KINDS.map((k) => (
          <button key={k.id} type="button" disabled={disabled} className={`chip chip-sm ${kind === k.id ? "chip-on" : ""}`}
            onClick={() => setKind(k.id)}>{k.label}</button>
        ))}
      </div>
      <textarea className="in ta" rows={3} value={body} disabled={disabled} onChange={(e) => setBody(e.target.value)}
        placeholder={disabled ? "Your role cannot add notes." : "What was found, what was done, what it needs next."} />
      {error && <div className="banner banner-bad"><ShieldOff size={14} /> {error}</div>}
      {hard && (
        <div className="banner banner-bad">
          <ShieldOff size={14} /> Remove {sc.blocked.map((b) => b.label).join(" and ")}. Notes hold device history only.
        </div>
      )}
      {soft && (
        <div className="banner banner-warn">
          <AlertTriangle size={14} />
          <div>
            Looks like it may contain {advisoryLabels.join(", ")}.
            <label className="ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              No personal data in this note.
            </label>
          </div>
        </div>
      )}
      <div className="composer-ft">
        <button className="btn btn-solid btn-sm" disabled={!can} onClick={submit}>
          {busy ? "Adding…" : "Add note"}
        </button>
      </div>
    </div>
  );
}

function Detail({ device, query, identity, onEdit, onDelete, onAddNote, onDeleteNote, onStatus, onBack }) {
  if (!device) {
    return (
      <div className="detail detail-idle">
        <div className="idle">
          <div className="ruler" aria-hidden="true" />
          <p className="lbl">No record selected</p>
          <p className="idle-t">Search a serial, IMEI or ICCID — full or partial. Pick a result to read its repair history.</p>
        </div>
      </div>
    );
  }
  const canEdit = roleCan("changeStatus", identity) || roleCan("editIdentifiers", identity);
  const canDelete = roleCan("softDelete", identity);
  const notes = [...(device.notes || [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <div className="detail">
      <div className="detail-hd">
        <button className="icon-btn only-narrow" onClick={onBack} aria-label="Back to results"><ChevronLeft size={18} /></button>
        <span className="lbl">Record</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onEdit} disabled={!canEdit} aria-label="Edit record" title="Edit"><Pencil size={15} /></button>
        <button className="icon-btn icon-bad" onClick={onDelete} disabled={!canDelete}
          aria-label="Delete record" title={canDelete ? "Delete" : "Requires the manager role"}>
          <Trash2 size={15} />
        </button>
      </div>

      <div className="detail-bd">
        <div className="hero">
          <TypeTag id={device.type} />
          <h2 className="serial-lg mono"><Mark text={device.serial} query={query} /></h2>
          <div className="hero-sub">
            <span>{typeOf(device.type).label}</span>
            <span className="dot">·</span>
            <span>added {fmtDay(device.addedAt)}</span>
          </div>
        </div>

        <div className="block">
          <div className="lbl">Status</div>
          <div className="chips">
            {STATUSES.map((s) => (
              <button key={s.id} type="button" disabled={!roleCan("changeStatus", identity)}
                className={`chip ${device.status === s.id ? "chip-on" : ""}`}
                onClick={() => onStatus(s.id)}>{s.label}</button>
            ))}
          </div>
        </div>

        <div className="block">
          <div className="lbl">Identifiers</div>
          <dl className="ids">
            <div className="id-row">
              <dt>Serial</dt>
              <dd className="mono id-v"><Mark text={device.serial} query={query} /></dd>
            </div>
            <div className="id-row">
              <dt>IMEI</dt>
              <dd className="mono id-v">
                <GroupedId value={device.imei} kind="imei" query={query} />
                <CheckDigit value={device.imei} kind="imei" />
              </dd>
            </div>
            <div className="id-row">
              <dt>ICCID</dt>
              <dd className="mono id-v">
                <GroupedId value={device.iccid} kind="iccid" query={query} />
                <CheckDigit value={device.iccid} kind="iccid" />
              </dd>
            </div>
          </dl>
        </div>

        <div className="block">
          <div className="lbl">Notes for this device <em>{notes.length}</em></div>
          <NoteComposer onAdd={onAddNote} disabled={!roleCan("addNote", identity)} />
          {notes.length === 0 && <p className="muted">No notes yet. Log the first repair or observation above.</p>}
          <ol className="log">
            {notes.map((n) => (
              <li key={n.id} className="log-i">
                <div className="log-m">
                  <span className={`nk nk-${n.kind}`}>{(NOTE_KINDS.find((k) => k.id === n.kind) || {}).label || "Note"}</span>
                  <time className="log-t">{fmtDate(n.at)}</time>
                  {!IS_API && <button className="icon-btn icon-xs" onClick={() => onDeleteNote(n.id)} aria-label="Delete note"><X size={13} /></button>}
                </div>
                <p className="log-b">{n.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Import (the `local` backend only — the API has no bulk path yet;
   see DEPLOYMENT-READINESS 1.8)
   ══════════════════════════════════════════════════════════════ */

const TYPE_ALIASES = {
  loop: "loop", lp: "loop",
  loopphone: "loop_phone", lph: "loop_phone", phone: "loop_phone", looph: "loop_phone",
  "101": "101", "101a": "101a", "101pro": "101pro", pro: "101pro", "101p": "101pro",
  extender: "extender", ext: "extender", repeater: "extender",
};
const matchType = (raw) => TYPE_ALIASES[String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "")] || null;
const STATUS_ALIASES = {
  refurbished: "refurb", refurbishment: "refurb", refurbishing: "refurb",
  recon: "refurb", reconditioned: "refurb", reconditioning: "refurb",
  instock: "stock", available: "stock", inservice: "deployed", live: "deployed",
  repairing: "repair", onbench: "repair", withsupplier: "rma", warrantyreturn: "rma",
  scrapped: "retired", decommissioned: "retired",
};
const matchStatus = (raw) => {
  const k = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return null;
  if (STATUS_ALIASES[k]) return STATUS_ALIASES[k];
  const hit = STATUSES.find((s) => s.id === k || s.label.toLowerCase().replace(/[^a-z]/g, "") === k);
  return hit ? hit.id : null;
};

function parseDelimited(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n");
  const head = t.split("\n")[0] || "";
  const delim = (head.match(/\t/g) || []).length >= (head.match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const COLS = { serial: ["serial", "serialnumber", "sn", "serialno"], type: ["type", "devicetype", "model"], imei: ["imei"], iccid: ["iccid", "sim", "simid"], status: ["status", "state"], note: ["note", "notes", "comment", "remarks"] };

function planImport(text, devices) {
  const rows = parseDelimited(text);
  if (!rows.length) return { rows: [], header: null };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const maybe = rows[0].map(norm);
  const isHeader = maybe.some((h) => Object.values(COLS).some((a) => a.includes(h)));
  const order = ["serial", "type", "imei", "iccid", "status", "note"];
  let idx = {};
  if (isHeader) {
    maybe.forEach((h, i) => { for (const k of order) if (COLS[k].includes(h)) idx[k] = i; });
  } else {
    order.forEach((k, i) => { idx[k] = i; });
  }
  const body = isHeader ? rows.slice(1) : rows;
  const seen = new Map();
  const out = body.map((r, i) => {
    const get = (k) => (idx[k] != null ? String(r[idx[k]] ?? "").trim() : "");
    const serial = upper(get("serial"));
    const type = matchType(get("type"));
    const im = digits(get("imei"));
    const ic = digits(get("iccid"));
    const status = matchStatus(get("status")) || "stock";
    const note = get("note");
    const rec = { line: i + 1, serial, type, imei: im, iccid: ic, status, note };

    const sc = screen(`${serial} ${note}`);
    if (!serial) return { ...rec, ok: false, why: "no serial number" };
    if (sc.blocked.length) return { ...rec, ok: false, why: `contains ${sc.blocked[0].label} — remove it and re-paste` };
    if (sc.warned.length) return { ...rec, ok: false, why: `looks like ${sc.warned[0].label} — remove it and re-paste` };
    if (seen.has(serial)) return { ...rec, ok: false, why: `duplicate of line ${seen.get(serial)} in this file` };
    if (im && im.length !== 15) return { ...rec, ok: false, why: `IMEI is ${im.length} digits, expected 15` };
    if (ic && (ic.length < 18 || ic.length > 20)) return { ...rec, ok: false, why: `ICCID is ${ic.length} digits, expected 18–20` };
    const clash = devices.find((d) => (im && digits(d.imei) === im && upper(d.serial) !== serial) || (ic && digits(d.iccid) === ic && upper(d.serial) !== serial));
    if (clash) return { ...rec, ok: false, why: `IMEI/ICCID already held by ${clash.serial}` };
    seen.set(serial, i + 1);
    const existing = devices.find((d) => upper(d.serial) === serial);
    return { ...rec, ok: true, merge: !!existing, why: existing ? "updates existing record" : type ? "new record" : "new record, type blank" };
  });
  return { rows: out, header: isHeader };
}

function ImportPane({ devices, onCommit, onCancel }) {
  const [text, setText] = useState("");
  const plan = useMemo(() => (text.trim() ? planImport(text, devices) : { rows: [] }), [text, devices]);
  const good = plan.rows.filter((r) => r.ok);
  const bad = plan.rows.filter((r) => !r.ok);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Import devices">
      <div className="sheet-hd">
        <span className="lbl">Import devices</span>
        <button className="icon-btn" onClick={onCancel} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="sheet-bd">
        <p className="muted">
          Paste rows as CSV or tab-separated, one device per line. Column order, or a header row:
          <code className="code">serial, type, imei, iccid, status, note</code>
          Only serial is required. Matching serials update the existing record and keep its notes.
        </p>
        <textarea className="in ta mono" rows={8} value={text} spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder={"serial,type,imei,iccid,status,note\nLP24A00317,loop,352099001761481,8944500912345678901,deployed,\nEX24B00088,extender,,,stock,"} />
        {plan.rows.length > 0 && (
          <>
            <div className="tally">
              <span className="tally-i tally-ok">{good.length} ready</span>
              {bad.length > 0 && <span className="tally-i tally-bad">{bad.length} rejected</span>}
              {plan.header && <span className="tally-i">header row detected</span>}
            </div>
            <ul className="plan">
              {plan.rows.slice(0, 60).map((r) => (
                <li key={r.line} className={r.ok ? "plan-ok" : "plan-bad"}>
                  <span className="plan-n mono">{r.line}</span>
                  <span className="plan-s mono">{r.serial || "—"}</span>
                  <span className="plan-w">{r.why}</span>
                </li>
              ))}
            </ul>
            {plan.rows.length > 60 && <p className="muted">…and {plan.rows.length - 60} more rows.</p>}
          </>
        )}
      </div>
      <div className="sheet-ft">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-solid" disabled={!good.length} onClick={() => onCommit(good)}>
          Import {good.length || ""} {good.length === 1 ? "device" : "devices"}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Root
   ══════════════════════════════════════════════════════════════ */

export default function DeviceIndex() {
  const [devices, setDevices] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [storeless, setStoreless] = useState(false);

  // api backend only
  const [identity, setIdentity] = useState(null);
  const [globalError, setGlobalError] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [deleteReason, setDeleteReason] = useState("");
  const bumpRefresh = () => setRefreshNonce((n) => n + 1);

  const [q, setQ] = useState("");
  const [fType, setFType] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [selId, setSelId] = useState(null);
  const [modal, setModal] = useState(null); // 'add' | 'edit' | 'import' | 'reset'
  const [toast, setToast] = useState(null);
  const searchRef = useRef(null);
  const barRef = useRef(null);
  const dirty = useRef(false);

  // The results list and detail pane hang off the sticky search bar's height.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const set = () => el.parentElement?.style.setProperty("--sbh", `${el.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  // Read the current fleet without making the effect below depend on it —
  // otherwise adding a note would re-run the effect and drop the selection.
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);

  // Starting a new search means looking for a different device. But if the
  // query is a complete identifier matching exactly one record, open it.
  // A barcode scanner types the whole serial and sends Enter; making the
  // technician then tap the single result defeats the point of scanning.
  // (api backend: this is handled inside the search effect below, using the
  // server's own matchKind rather than a client-side re-scan.)
  useEffect(() => {
    if (IS_API) return;
    const raw = q.trim();
    if (!raw) { setSelId(null); return; }
    const alnum = upper(raw.replace(/[^a-z0-9]/gi, ""));
    const dig = digits(raw);
    const hits = devicesRef.current.filter(
      (d) =>
        (alnum.length >= 3 && upper(d.serial).replace(/[^A-Z0-9]/g, "") === alnum) ||
        (dig.length >= 15 && (digits(d.imei) === dig || digits(d.iccid) === dig))
    );
    setSelId(hits.length === 1 ? hits[0].id : null);
  }, [q]);

  // Initial load: local reads the one storage blob; api fetches identity and
  // lets the search effect below populate the list.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (IS_API) {
        try {
          const m = await metaApi.get();
          if (!alive) return;
          setIdentity(m.you);
          setGlobalError(null);
        } catch (e) {
          if (!alive) return;
          setGlobalError(describeApiError(e));
        }
        setLoaded(true);
        return;
      }
      if (!(typeof window !== "undefined" && window.storage)) setStoreless(true);
      const d = await store.read();
      if (!alive) return;
      if (d) setDevices(d);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  // Server-side search, debounced. Replaces client-side filtering entirely
  // for the api backend — the fleet is never held in memory (D15/D18).
  useEffect(() => {
    if (!IS_API || !loaded) return;
    let alive = true;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await devicesApi.search({
          q: q.trim() || undefined,
          type: fType !== "all" ? fType : undefined,
          status: fStatus !== "all" ? fStatus : undefined,
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (!alive) return;
        const mapped = res.results.map(fromApiDevice);
        setDevices(mapped);
        setHasMore(res.hasMore);
        setOffset(mapped.length);
        setSearchError(null);
        if (q.trim() && mapped.length === 1 && mapped[0].matchKind === "exact") {
          setSelId(mapped[0].id);
        }
      } catch (e) {
        if (!alive) return;
        setSearchError(describeApiError(e));
      } finally {
        if (alive) setSearchLoading(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, fType, fStatus, loaded, refreshNonce]);

  const loadMore = async () => {
    setSearchLoading(true);
    try {
      const res = await devicesApi.search({
        q: q.trim() || undefined,
        type: fType !== "all" ? fType : undefined,
        status: fStatus !== "all" ? fStatus : undefined,
        limit: PAGE_SIZE,
        offset,
      });
      const mapped = res.results.map(fromApiDevice);
      setDevices((prev) => [...prev, ...mapped]);
      setHasMore(res.hasMore);
      setOffset(offset + mapped.length);
    } catch (e) {
      setSearchError(describeApiError(e));
    } finally {
      setSearchLoading(false);
    }
  };

  // Fetch the full record + notes for whatever is selected. Search results
  // carry summary fields only (noteCount, no note bodies).
  useEffect(() => {
    if (!IS_API) return;
    if (!selId) { setSelectedDetail(null); return; }
    let alive = true;
    (async () => {
      try {
        const [dev, notesRes] = await Promise.all([devicesApi.get(selId), notesApi.list(selId)]);
        if (!alive) return;
        setSelectedDetail(fromApiDevice(dev, notesRes.notes.map(fromApiNote)));
      } catch (e) {
        if (!alive) return;
        setSelectedDetail(null);
        setToast({ bad: true, msg: describeApiError(e) });
      }
    })();
    return () => { alive = false; };
  }, [selId, refreshNonce]);

  useEffect(() => {
    if (IS_API || !loaded || !dirty.current) return;
    let alive = true;
    setSaving(true);
    const t = setTimeout(async () => {
      const ok = await store.write(devices);
      if (!alive) return;
      setSaving(false);
      if (ok) setSavedAt(new Date().toISOString());
      else setToast({ bad: true, msg: "Could not save to storage. Export a copy before you close this." });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [devices, loaded]);

  const commit = useCallback((fn) => { dirty.current = true; setDevices(fn); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape") { if (modal) setModal(null); else if (!typing && q) setQ(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, q]);

  const results = useMemo(() => {
    if (IS_API) return devices;
    const needle = q.trim();
    const alnum = upper(needle.replace(/[^a-z0-9]/gi, ""));
    const dig = digits(needle);
    const words = needle.toLowerCase().split(/\s+/).filter(Boolean);
    let list = devices.filter((d) => {
      if (fType !== "all" && d.type !== fType) return false;
      if (fStatus !== "all" && d.status !== fStatus) return false;
      if (!needle) return true;
      const sn = upper(d.serial).replace(/[^A-Z0-9]/g, "");
      if (alnum && sn.includes(alnum)) return true;
      if (dig && (digits(d.imei).includes(dig) || digits(d.iccid).includes(dig))) return true;
      const hay = (d.notes || []).map((n) => n.body).join(" ").toLowerCase();
      if (words.length && words.every((w) => hay.includes(w))) return true;
      return false;
    });
    if (needle && alnum) {
      list = [...list].sort((a, b) => {
        const ai = upper(a.serial).replace(/[^A-Z0-9]/g, "").indexOf(alnum);
        const bi = upper(b.serial).replace(/[^A-Z0-9]/g, "").indexOf(alnum);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
    } else {
      list = [...list].sort((a, b) => upper(a.serial).localeCompare(upper(b.serial)));
    }
    return list;
  }, [devices, q, fType, fStatus]);

  const selected = IS_API ? selectedDetail : (devices.find((d) => d.id === selId) || null);

  // A bare 15-digit string is an IMEI, an 18–20 digit string is an ICCID.
  const prefill = useMemo(() => {
    const raw = q.trim();
    if (!raw) return {};
    const d = digits(raw);
    const onlyDigits = raw.replace(/[\s-]/g, "") === d;
    if (onlyDigits && d.length === 15) return { imei: d };
    if (onlyDigits && d.length >= 18 && d.length <= 20) return { iccid: d };
    return { serial: upper(raw) };
  }, [q]);

  /* actions */
  const saveRecord = (rec) => {
    if (IS_API) {
      setSelId(rec.id);
      setModal(null);
      bumpRefresh();
      setToast({ msg: "Saved." });
      return;
    }
    commit((prev) => {
      const i = prev.findIndex((d) => d.id === rec.id);
      if (i < 0) return [...prev, rec];
      const next = [...prev]; next[i] = rec; return next;
    });
    setSelId(rec.id);
    setModal(null);
    setToast({ msg: `${rec.serial} saved.` });
  };
  const patch = (id, fn) => commit((prev) => prev.map((d) => (d.id === id ? { ...fn(d), updatedAt: new Date().toISOString() } : d)));

  const setStatusApi = async (id, status) => {
    try {
      await devicesApi.patch(id, { status });
      setSelectedDetail((d) => (d ? { ...d, status } : d));
      bumpRefresh();
    } catch (e) {
      setToast({ bad: true, msg: describeApiError(e) });
    }
  };

  const onAddNoteLocal = ({ body, kind }) => {
    const n = { id: uid("n"), body, kind, at: new Date().toISOString() };
    patch(selected.id, (d) => ({ ...d, notes: [...(d.notes || []), n] }));
    return Promise.resolve();
  };
  const onAddNoteApi = async ({ body, kind, acknowledgeAdvisory }) => {
    const saved = await notesApi.add(selected.id, { body, kind: noteKindToApi(kind), acknowledgeAdvisory });
    setSelectedDetail((d) => (d ? { ...d, notes: [fromApiNote(saved), ...(d.notes || [])] } : d));
  };

  const removeDeviceLocal = (d) => {
    commit((prev) => prev.filter((x) => x.id !== d.id));
    setSelId(null); setModal(null);
    setToast({ msg: `${d.serial} deleted.` });
  };
  const removeDeviceApi = async (d) => {
    if (deleteReason.trim().length < 8) return;
    try {
      await devicesApi.softDelete(d.id, deleteReason.trim());
      setSelId(null); setModal(null); setDeleteReason("");
      bumpRefresh();
      setToast({ msg: `${d.serial} deleted.` });
    } catch (e) {
      setToast({ bad: true, msg: describeApiError(e) });
    }
  };
  const removeDevice = (d) => (IS_API ? removeDeviceApi(d) : removeDeviceLocal(d));

  const doImport = (rows) => {
    if (IS_API) return; // the Import control is disabled in this mode
    const now = new Date().toISOString();
    commit((prev) => {
      const next = [...prev];
      for (const r of rows) {
        const i = next.findIndex((d) => upper(d.serial) === r.serial);
        const note = r.note ? [{ id: uid("n"), body: r.note, kind: "obs", at: now }] : [];
        if (i >= 0) {
          const cur = next[i];
          next[i] = {
            ...cur,
            type: r.type || cur.type,
            imei: r.imei || cur.imei,
            iccid: r.iccid || cur.iccid,
            status: r.status || cur.status,
            notes: [...(cur.notes || []), ...note],
            updatedAt: now,
          };
        } else {
          next.push({ id: uid("dev"), serial: r.serial, type: r.type || "", imei: r.imei, iccid: r.iccid, status: r.status, notes: note, addedAt: now, updatedAt: now });
        }
      }
      return next;
    });
    setModal(null);
    setToast({ msg: `Imported ${rows.length} row${rows.length === 1 ? "" : "s"}.` });
  };

  const csv = useMemo(() => {
    const esc = (v) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [["serial", "type", "imei", "iccid", "status", "added", "notes"].join(",")];
    for (const d of [...devices].sort((a, b) => upper(a.serial).localeCompare(upper(b.serial)))) {
      const notes = (d.notes || []).map((n) => `[${fmtDay(n.at)} ${n.kind}] ${n.body}`).join(" | ");
      lines.push([d.serial, d.type, d.imei, d.iccid, d.status, d.addedAt, notes].map(esc).join(","));
    }
    return lines.join("\n");
  }, [devices]);

  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(csv);
      setToast({ msg: `${devices.length} record${devices.length === 1 ? "" : "s"} copied.` });
    } catch {
      setToast({ bad: true, msg: "Copy blocked — select the text and copy it by hand." });
    }
  };
  const downloadCsv = () => {
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `device-index-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch {
      setToast({ bad: true, msg: "Download blocked here — use Copy instead." });
    }
  };

  const downloadCsvApi = async () => {
    try {
      const text = await devicesApi.exportCsv();
      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `device-register-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) {
      setToast({ bad: true, msg: describeApiError(e) });
    }
  };

  const wipeAll = async () => {
    if (IS_API) return; // no bulk-delete capability, deliberately — see D4
    await store.wipe();
    dirty.current = false;
    setDevices([]); setSelId(null); setModal(null);
    setToast({ msg: "Index cleared." });
  };

  const counts = useMemo(() => {
    const byType = {}; const byStatus = {};
    for (const d of devices) { byType[d.type] = (byType[d.type] || 0) + 1; byStatus[d.status] = (byStatus[d.status] || 0) + 1; }
    return { byType, byStatus };
  }, [devices]);

  const canRegister = roleCan("registerDevice", identity);

  return (
    <div className="app">
      <style>{CSS}</style>

      <header className="top">
        <div className="top-in">
          <div className="brand">
            <span className="brand-m">Device Index</span>
            <span className="brand-s">central device register</span>
          </div>
          <div className="spacer" />
          <span className="count mono">{devices.length}{IS_API && hasMore ? "+" : ""} <em>records</em></span>
          <button className="btn btn-solid btn-sm" disabled={!canRegister}
            title={canRegister ? undefined : "Requires the warehouse or manager role"}
            onClick={() => setModal("add")}><Plus size={14} /> Add device</button>
        </div>
        <div className="ruler" aria-hidden="true" />
        <div className="rule-strip">
          <ShieldOff size={12} />
          <span>Device data only — no names, contacts, addresses or any other individual data. There is no field for it, and free text is screened.</span>
        </div>
      </header>

      {IS_API && globalError && (
        <div className="banner banner-bad" style={{ margin: "10px 16px" }}>
          <ShieldOff size={14} /> {globalError}
        </div>
      )}

      <div className="search-bar" ref={barRef}>
        <div className="search">
          <Search size={17} className="search-i" />
          <input
            ref={searchRef} className="search-in mono" value={q} spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the top result. Scanners send it automatically;
              // for a partial fragment it saves reaching for the screen.
              if (e.key === "Enter" && results.length > 0) {
                e.preventDefault();
                setSelId(results[0].id);
                e.currentTarget.blur();   // dismiss the on-screen keyboard
              }
            }}
            placeholder="Scan or type a serial, IMEI or ICCID — partial is fine"
            aria-label="Search the device index"
          />
          {q && <button className="icon-btn" onClick={() => setQ("")} aria-label="Clear search"><X size={15} /></button>}
        </div>
        <div className="filters">
          <div className="fgroup" role="group" aria-label="Filter by type">
            <button className={`fchip ${fType === "all" ? "fchip-on" : ""}`} onClick={() => setFType("all")}>All types</button>
            {TYPES.map((t) => (
              <button key={t.id} className={`fchip ${fType === t.id ? "fchip-on" : ""}`} onClick={() => setFType(t.id)}>
                {t.label}{counts.byType[t.id] ? <em>{counts.byType[t.id]}</em> : null}
              </button>
            ))}
          </div>
          <div className="fgroup" role="group" aria-label="Filter by status">
            <button className={`fchip ${fStatus === "all" ? "fchip-on" : ""}`} onClick={() => setFStatus("all")}>Any status</button>
            {STATUSES.map((s) => (
              <button key={s.id} className={`fchip ${fStatus === s.id ? "fchip-on" : ""}`} onClick={() => setFStatus(s.id)}>
                {s.label}{counts.byStatus[s.id] ? <em>{counts.byStatus[s.id]}</em> : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className={`main ${selected ? "main-detail" : ""}`}>
        <section className="list" aria-label="Search results">
          <div className="list-hd">
            <span className="lbl">
              {q || fType !== "all" || fStatus !== "all"
                ? `${results.length}${IS_API && hasMore ? "+" : ""} matching`
                : IS_API ? `${results.length}${hasMore ? "+" : ""} devices` : "All devices"}
            </span>
            {IS_API && searchLoading && <Loader2 size={12} className="spin" style={{ marginLeft: 8 }} />}
          </div>

          {!loaded && <div className="pad muted"><Loader2 size={14} className="spin" /> Loading the index…</div>}
          {IS_API && searchError && <div className="pad muted">{searchError}</div>}

          {loaded && !IS_API && devices.length === 0 && (
            <div className="pad empty">
              <p className="empty-h">The index is empty.</p>
              <p className="muted">Add the first device, or paste a list you already have.</p>
              <div className="empty-a">
                <button className="btn btn-solid btn-sm" onClick={() => setModal("add")}><Plus size={14} /> Add device</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setModal("import")}><Upload size={14} /> Import list</button>
              </div>
            </div>
          )}

          {loaded && !IS_API && devices.length > 0 && results.length === 0 && (
            <div className="pad empty">
              <p className="empty-h">Nothing matches {q ? <span className="mono">{q}</span> : "these filters"}.</p>
              <p className="muted">Check the digits, widen the filters, or record it as a new device.</p>
              {q && <button className="btn btn-ghost btn-sm" onClick={() => setModal("add")}><Plus size={14} /> Add {q.trim().slice(0, 24)}</button>}
            </div>
          )}

          {loaded && IS_API && !searchLoading && results.length === 0 && !searchError && (
            <div className="pad empty">
              <p className="empty-h">
                {q || fType !== "all" || fStatus !== "all" ? <>Nothing matches {q ? <span className="mono">{q}</span> : "these filters"}.</> : "No devices yet."}
              </p>
              <p className="muted">
                {q || fType !== "all" || fStatus !== "all" ? "Check the digits, or widen the filters." : "Add the first device."}
              </p>
              {canRegister && <button className="btn btn-solid btn-sm" onClick={() => setModal("add")}><Plus size={14} /> Add device</button>}
            </div>
          )}

          <ul className="rows">
            {results.map((d) => (
              <li key={d.id}>
                <button className={`row ${selId === d.id ? "row-on" : ""}`} onClick={() => setSelId(d.id)}>
                  <TypeTag id={d.type} />
                  <span className="row-main">
                    <span className="row-sn mono"><Mark text={d.serial} query={q} /></span>
                    {(d.imei || d.iccid) ? (
                      <span className="row-ids mono">
                        {d.imei && <span className="row-id"><i>IMEI</i><GroupedId value={d.imei} kind="imei" query={q} /></span>}
                        {d.iccid && <span className="row-id"><i>ICCID</i><GroupedId value={d.iccid} kind="iccid" query={q} /></span>}
                      </span>
                    ) : (
                      <span className="row-none">no IMEI or ICCID recorded</span>
                    )}
                  </span>
                  <span className="row-r">
                    <StatusChip id={d.status} small />
                    {(IS_API ? d.noteCount : (d.notes || []).length) > 0 && (
                      <span className="nct mono">{IS_API ? d.noteCount : d.notes.length} note{(IS_API ? d.noteCount : d.notes.length) === 1 ? "" : "s"}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {IS_API && hasMore && (
            <div className="pad">
              <button className="btn btn-ghost btn-sm" disabled={searchLoading} onClick={loadMore}>
                {searchLoading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </section>

        <Detail
          device={selected}
          query={q}
          identity={identity}
          onBack={() => setSelId(null)}
          onEdit={() => setModal("edit")}
          onDelete={() => setModal("delete")}
          onStatus={(s) => (IS_API ? setStatusApi(selected.id, s) : patch(selected.id, (d) => ({ ...d, status: s })))}
          onAddNote={IS_API ? onAddNoteApi : onAddNoteLocal}
          onDeleteNote={(nid) => patch(selected.id, (d) => ({ ...d, notes: (d.notes || []).filter((x) => x.id !== nid) }))}
        />
      </main>

      <footer className="foot">
        <span className="foot-s mono">
          {IS_API
            ? (identity ? `${identity.actor} · ${identity.role}` : globalError ? "Not connected" : "Connecting…")
            : (storeless ? "Storage unavailable — this session only" :
              saving ? "Saving…" : savedAt ? `Saved ${fmtDate(savedAt)}` : "Saved to your private index")}
        </span>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" disabled={IS_API}
          title={IS_API ? "Bulk import isn't available through the API yet — see DEPLOYMENT-READINESS 1.8" : undefined}
          onClick={() => setModal("import")}><Upload size={13} /> Import</button>
        <button className="btn btn-ghost btn-sm" disabled={IS_API ? !roleCan("export", identity) : !devices.length}
          title={IS_API && !roleCan("export", identity) ? "Requires the manager role" : undefined}
          onClick={() => (IS_API ? downloadCsvApi() : setModal("export"))}><Download size={13} /> Export</button>
        <button className="btn btn-ghost btn-sm btn-bad" disabled={IS_API || !devices.length}
          title={IS_API ? "Not available against the API — devices are soft-deleted individually, with a reason" : undefined}
          onClick={() => setModal("reset")}><RotateCcw size={13} /> Clear</button>
      </footer>

      {modal && (
        <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          {modal === "add" && <RecordForm devices={devices} prefill={prefill} identity={identity} onSave={saveRecord} onCancel={() => setModal(null)} />}
          {modal === "edit" && selected && <RecordForm initial={selected} devices={devices} identity={identity} onSave={saveRecord} onCancel={() => setModal(null)} />}
          {modal === "import" && !IS_API && <ImportPane devices={devices} onCommit={doImport} onCancel={() => setModal(null)} />}
          {modal === "delete" && selected && (
            <div className="sheet sheet-sm" role="dialog" aria-modal="true">
              <div className="sheet-hd"><span className="lbl">Delete record</span>
                <button className="icon-btn" onClick={() => { setModal(null); setDeleteReason(""); }} aria-label="Close"><X size={16} /></button></div>
              <div className="sheet-bd">
                {IS_API ? (
                  <>
                    <p>Deleting <b className="mono">{selected.serial}</b> marks it removed from the active index. The record and its notes are retained for audit — nothing is erased.</p>
                    <Field label="Reason" hint="at least 8 characters, kept with the audit record">
                      <textarea className="in ta" rows={2} value={deleteReason}
                        onChange={(e) => setDeleteReason(e.target.value)}
                        placeholder="e.g. duplicate registration, scrapped beyond repair" />
                    </Field>
                  </>
                ) : (
                  <p>Deleting <b className="mono">{selected.serial}</b> removes its {(selected.notes || []).length} note{(selected.notes || []).length === 1 ? "" : "s"} as well. This cannot be undone.</p>
                )}
              </div>
              <div className="sheet-ft">
                <button className="btn btn-ghost" onClick={() => { setModal(null); setDeleteReason(""); }}>Keep record</button>
                <button className="btn btn-bad-solid" disabled={IS_API && deleteReason.trim().length < 8} onClick={() => removeDevice(selected)}>Delete record</button>
              </div>
            </div>
          )}
          {modal === "export" && !IS_API && (
            <div className="sheet" role="dialog" aria-modal="true">
              <div className="sheet-hd"><span className="lbl">Export {devices.length} records</span>
                <button className="icon-btn" onClick={() => setModal(null)} aria-label="Close"><X size={16} /></button></div>
              <div className="sheet-bd">
                <p className="muted">CSV, one device per row, notes flattened into the last column. Paste it straight back into the import box to restore.</p>
                <textarea className="in ta mono" rows={9} readOnly value={csv} onFocus={(e) => e.target.select()} />
              </div>
              <div className="sheet-ft">
                <button className="btn btn-ghost" onClick={downloadCsv}><Download size={13} /> Download file</button>
                <button className="btn btn-solid" onClick={copyCsv}>Copy CSV</button>
              </div>
            </div>
          )}
          {modal === "reset" && !IS_API && (
            <div className="sheet sheet-sm" role="dialog" aria-modal="true">
              <div className="sheet-hd"><span className="lbl">Clear the index</span>
                <button className="icon-btn" onClick={() => setModal(null)} aria-label="Close"><X size={16} /></button></div>
              <div className="sheet-bd">
                <p>This deletes all {devices.length} records and their notes. It cannot be undone. Export a CSV first if you want a copy.</p>
              </div>
              <div className="sheet-ft">
                <button className="btn btn-ghost" onClick={() => setModal(null)}>Keep records</button>
                <button className="btn btn-bad-solid" onClick={wipeAll}>Delete everything</button>
              </div>
            </div>
          )}
        </div>
      )}

      {toast && <div className={`toast ${toast.bad ? "toast-bad" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Styles
   ══════════════════════════════════════════════════════════════ */

const CSS = `
.app{
  --ink:#14171A; --ink-2:#3A424A; --steel:#6D7883; --steel-2:#9AA4AD;
  --wall:#E4E7EC; --card:#FBFBF9; --rule:#CDD3DC; --rule-2:#DEE2E8;
  /* D21: four blues, one job each. --blue is the primary/brand hue (with
     -d/-t shade and tint, same pattern the old --oxide family used);
     --blue-link, --blue-focus and --blue-active are distinct hues, each
     doing exactly one job, so a focus ring is never mistaken for a link
     and a selected row is never mistaken for the header chrome. */
  --blue:#0B3D91; --blue-d:#082C6B; --blue-t:#E3EAF8;
  --blue-link:#1656C9; --blue-focus:#1E7FE0; --blue-active:#4C6FA5;
  --amber:#8F5A0C; --amber-t:#F6EBD7; --rust:#8C2E1E; --rust-t:#F6E3DF;
  --mono:ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--wall); color:var(--ink); font-family:var(--sans);
  min-height:100vh; display:flex; flex-direction:column;
  font-size:14px; line-height:1.45; -webkit-font-smoothing:antialiased;
}
.app *{box-sizing:border-box;}
.app button{font:inherit; color:inherit; cursor:pointer;}
.mono{font-family:var(--mono); font-variant-ligatures:none;}
.spacer{flex:1;}
.muted{color:var(--steel); font-size:13px;}
.pad{padding:22px 16px;}

/* labels */
.lbl{font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.15em;
  text-transform:uppercase; color:var(--steel);}
.lbl em{font-style:normal; margin-left:6px; color:var(--steel-2);}

/* header */
.top{background:var(--blue); color:#EAF0FB;}
.top-in{display:flex; align-items:center; gap:12px; padding:11px 16px; max-width:1320px; margin:0 auto; width:100%;}
.brand{display:flex; flex-direction:column; line-height:1.15;}
.brand-m{font-family:var(--mono); font-size:14px; font-weight:700; letter-spacing:.2em; text-transform:uppercase;}
.brand-s{font-family:var(--mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:#9BBBAB;}
.count{font-size:12px; color:#B9D2C5; white-space:nowrap;}
.count em{font-style:normal; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;}
.ruler{height:7px;
  background-image:repeating-linear-gradient(to right,#0F3D31 0 1px,transparent 1px 8px),
                   repeating-linear-gradient(to right,#0F3D31 0 1px,transparent 1px 40px);
  background-size:100% 3px,100% 7px; background-repeat:no-repeat; background-position:left bottom,left bottom;
  background-color:#174C3D;}
.rule-strip{display:flex; align-items:flex-start; gap:8px; padding:7px 16px;
  background:#12332B; color:#A9C6B8; font-size:11.5px; line-height:1.35;}
.rule-strip svg{flex:none; margin-top:1px;}

/* search */
.search-bar{background:var(--card); border-bottom:1px solid var(--rule);
  position:sticky; top:0; z-index:20; box-shadow:0 1px 0 rgba(20,23,26,.04);}
.search{display:flex; align-items:center; gap:9px; padding:10px 16px; border-bottom:1px solid var(--rule-2);
  max-width:1320px; margin:0 auto;}
.search-i{color:var(--blue-link); flex:none;}
.search-in{flex:1; border:0; outline:0; background:transparent; font-size:16px; letter-spacing:.03em; color:var(--ink); min-width:0;}
.search-in::placeholder{color:var(--steel-2); letter-spacing:0; font-family:var(--sans); font-size:14px;}
.filters{display:flex; flex-direction:column; gap:5px; padding:8px 16px 10px; max-width:1320px; margin:0 auto;}
.fgroup{display:flex; gap:5px; overflow-x:auto; scrollbar-width:none; padding-bottom:1px;}
.fgroup::-webkit-scrollbar{display:none;}
.fchip{border:1px solid var(--rule); background:#fff; color:var(--ink-2);
  font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
  padding:4px 9px; border-radius:2px; white-space:nowrap; transition:background .12s,border-color .12s;}
.fchip:hover{border-color:var(--steel);}
.fchip-on{background:var(--blue-active); border-color:var(--blue-active); color:#fff;}
.fchip em{font-style:normal; margin-left:5px; opacity:.6;}

/* layout */
.main{flex:1; display:grid; grid-template-columns:minmax(0,1fr); max-width:1320px; margin:0 auto; width:100%;}
@media(min-width:920px){
  .main{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr); align-items:start;}
}
.list{border-right:1px solid var(--rule); min-width:0;}
.list-hd{padding:9px 16px 6px; display:flex; align-items:center;}
.rows{list-style:none; margin:0; padding:0 0 24px;}

.row{width:100%; display:flex; align-items:flex-start; gap:11px; text-align:left;
  padding:11px 16px 11px 13px; background:transparent; border:0; border-bottom:1px solid var(--rule-2);
  border-left:3px solid transparent; transition:background .12s;}
.row:hover{background:#EFF1EC;}
.row-on{background:var(--blue-t); border-left-color:var(--blue-active);}
.row:focus-visible{outline:2px solid var(--blue-focus); outline-offset:-2px;}
.row-main{flex:1; min-width:0;}
.row-sn{display:block; font-size:15px; font-weight:600; letter-spacing:.04em;}
.row-ids{display:flex; flex-wrap:wrap; gap:2px 14px; margin-top:3px;}
.row-id{display:flex; align-items:baseline; gap:6px; font-size:11.5px; color:var(--steel);}
.row-id i{font-style:normal; font-size:8.5px; font-weight:700; letter-spacing:.12em; color:var(--steel-2);}
.row-r{display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex:none;}
.nct{font-size:10px; color:var(--steel-2); letter-spacing:.04em;}
.row-none{display:block; margin-top:3px; font-size:11.5px; color:var(--steel-2); font-style:italic;}

/* type tag */
.tt{flex:none; font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.06em;
  background:var(--ink); color:#F2F3EF; padding:3px 5px; border-radius:2px; margin-top:2px; min-width:30px; text-align:center;}

/* status */
.st{display:inline-flex; align-items:center; gap:5px; font-family:var(--mono);
  font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-2); white-space:nowrap;}
.st i{width:6px; height:6px; border-radius:50%; background:var(--steel); flex:none;}
.st-good i{background:var(--blue);} .st-warn i{background:var(--amber);}
.st-dead i{background:var(--steel-2);} .st-neutral i{background:#7E9BC4;}
.st-refurb i{background:#6B5C8C;}
.st-sm{font-size:9.5px;}

/* identifiers */
.id-run{display:inline-flex; flex-wrap:wrap; gap:0 7px; letter-spacing:.06em;}
.id-grp{white-space:nowrap;}
.id-empty{color:var(--steel-2); font-family:var(--sans); font-size:12px; font-style:italic; letter-spacing:0;}
.hl{background:#F2DE8B; box-shadow:0 0 0 1px #E3C95F inset; border-radius:1px;}
.cd{display:inline-flex; align-items:center; gap:3px; margin-left:9px;
  font-family:var(--mono); font-size:9px; letter-spacing:.08em; text-transform:uppercase;
  padding:1px 4px; border-radius:2px; white-space:nowrap;}
.cd-ok{background:var(--blue-t); color:var(--blue-d);}
.cd-bad{background:var(--amber-t); color:var(--amber);}

/* detail */
.detail{min-width:0; background:var(--card); min-height:340px;}
@media(min-width:920px){
  .detail{position:sticky; top:var(--sbh,118px); max-height:calc(100vh - var(--sbh,118px)); overflow:auto;}
}
@media(max-width:919px){
  .main-detail .list{display:none;}
  .detail{border-top:1px solid var(--rule);}
  .detail-idle{display:none;}
}
@media(min-width:920px){ .only-narrow{display:none !important;} }
.detail-hd{display:flex; align-items:center; gap:6px; padding:9px 14px; border-bottom:1px solid var(--rule-2);
  position:sticky; top:0; background:var(--card); z-index:2;}
.detail-bd{padding:4px 18px 40px;}
.detail-idle{display:flex; align-items:center; justify-content:center; padding:40px 24px;}
.idle{text-align:center; max-width:280px;}
.idle .ruler{margin:0 auto 16px; width:100px; opacity:.5; background-color:var(--rule);}
.idle-t{color:var(--steel); font-size:13px; margin:8px 0 0;}

.hero{padding:18px 0 16px; border-bottom:1px solid var(--rule-2);}
.hero .tt{display:inline-block; margin:0 0 8px;}
.serial-lg{margin:0; font-size:27px; font-weight:700; letter-spacing:.02em; line-height:1.1; word-break:break-all;}
.hero-sub{margin-top:5px; font-size:12.5px; color:var(--steel); display:flex; gap:7px; flex-wrap:wrap;}
.dot{color:var(--steel-2);}

.block{padding:16px 0; border-bottom:1px solid var(--rule-2);}
.block .lbl{display:block; margin-bottom:9px;}
.ids{margin:0;}
.id-row{display:flex; gap:12px; padding:7px 0; border-bottom:1px dotted var(--rule-2); align-items:baseline;}
.id-row:last-child{border-bottom:0;}
.id-row dt{flex:none; width:52px; font-family:var(--mono); font-size:9.5px; font-weight:700;
  letter-spacing:.12em; text-transform:uppercase; color:var(--steel-2);}
.id-row dd{margin:0; min-width:0;}
.id-v{font-size:14px; display:flex; flex-wrap:wrap; align-items:center;}

/* notes log */
.composer{background:#F3F5F0; border:1px solid var(--rule-2); border-radius:2px; padding:10px; margin-bottom:14px;}
.composer-ft{display:flex; justify-content:flex-end; margin-top:8px;}
.log{list-style:none; margin:0; padding:0;}
.log-i{border-left:2px solid var(--rule); padding:0 0 14px 12px; margin-left:2px; position:relative;}
.log-i:before{content:""; position:absolute; left:-4px; top:5px; width:6px; height:6px; background:var(--blue); border-radius:50%;}
.log-m{display:flex; align-items:center; gap:8px;}
.log-t{font-family:var(--mono); font-size:10px; letter-spacing:.05em; color:var(--steel-2);}
.log-b{margin:3px 0 0; white-space:pre-wrap; font-size:13.5px; color:var(--ink-2);}
.nk{font-family:var(--mono); font-size:9px; font-weight:700; letter-spacing:.1em; text-transform:uppercase;
  padding:2px 5px; border-radius:2px;}
.nk-repair{background:var(--amber-t); color:var(--amber);}
.nk-obs{background:#E7EAE4; color:var(--ink-2);}

/* controls */
.btn{display:inline-flex; align-items:center; gap:6px; border:1px solid transparent; border-radius:2px;
  font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.09em; text-transform:uppercase;
  padding:7px 12px; transition:background .12s,border-color .12s,opacity .12s;}
.btn-sm{padding:5px 9px; font-size:10px;}
.btn-solid{background:var(--blue); color:#fff;}
.btn-solid:hover{background:var(--blue-d);}
.btn-ghost{background:transparent; border-color:var(--rule); color:var(--ink-2);}
.btn-ghost:hover{border-color:var(--steel); background:#fff;}
.btn-bad{color:var(--rust);}
.btn-bad-solid{background:var(--rust); color:#fff;}
.btn:disabled{opacity:.4; cursor:not-allowed;}
.top .btn-ghost{border-color:#3E6E5D; color:#DDE9E2;}
.top .btn-solid{background:#F3F6FB; color:var(--blue-d);}
.top .btn-solid:hover{background:#fff;}

.icon-btn{display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
  background:transparent; border:0; border-radius:2px; color:var(--steel); flex:none;}
.icon-btn:hover{background:#E9ECE6; color:var(--ink);}
.icon-btn:disabled{opacity:.35; cursor:not-allowed;}
.icon-btn:disabled:hover{background:transparent; color:var(--steel);}
.icon-bad:hover{background:var(--rust-t); color:var(--rust);}
.icon-xs{width:22px; height:22px;}
.app :focus-visible{outline:2px solid var(--blue-focus); outline-offset:1px;}

.chips{display:flex; flex-wrap:wrap; gap:5px;}
.chips-tight{margin-bottom:7px;}
.chip{border:1px solid var(--rule); background:#fff; color:var(--ink-2); border-radius:2px;
  font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; padding:5px 9px;}
.chip-sm{font-size:9.5px; padding:4px 8px;}
.chip:hover{border-color:var(--steel);}
.chip-on{background:var(--blue-active); border-color:var(--blue-active); color:#fff;}
.chip:disabled{opacity:.4; cursor:not-allowed;}

.fld{display:block; margin-bottom:15px;}
.fld-l{display:flex; align-items:baseline; gap:7px; margin-bottom:5px;
  font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; color:var(--steel);}
.fld-l em{font-style:normal; font-weight:400; letter-spacing:.04em; text-transform:none; color:var(--steel-2);}
.in{width:100%; border:1px solid var(--rule); background:#fff; border-radius:2px; padding:9px 10px;
  font-size:15px; color:var(--ink); outline:0;}
.in:focus{border-color:var(--blue); box-shadow:0 0 0 2px var(--blue-t);}
.in.mono{letter-spacing:.05em;}
.in:disabled,.in[readonly]{background:#F0F1EE; color:var(--steel);}
.ta{font-size:14px; line-height:1.45; resize:vertical; font-family:var(--sans);}
.ta.mono{font-family:var(--mono); font-size:12.5px;}
.row2{display:grid; grid-template-columns:1fr; gap:0;}
@media(min-width:560px){ .row2{grid-template-columns:1fr 1fr; gap:0 14px;} }
.fld-e,.fld-w{display:flex; align-items:flex-start; gap:5px; margin-top:5px; font-size:12px; line-height:1.35;}
.fld-e{color:var(--rust);} .fld-w{color:var(--amber);}
.fld-e svg,.fld-w svg{flex:none; margin-top:2px;}

.banner{display:flex; gap:8px; padding:9px 11px; border-radius:2px; font-size:12.5px; line-height:1.4; margin:10px 0;}
.banner svg{flex:none; margin-top:2px;}
.banner-bad{background:var(--rust-t); color:#6E2417;}
.banner-warn{background:var(--amber-t); color:#6E4508;}
.ack{display:flex; align-items:center; gap:7px; margin-top:7px; font-size:12.5px; cursor:pointer;}
.ack input{width:15px; height:15px; accent-color:var(--blue);}

/* modal */
.scrim{position:fixed; inset:0; background:rgba(18,26,22,.5); z-index:60;
  display:flex; align-items:flex-end; justify-content:center; padding:0;}
@media(min-width:700px){ .scrim{align-items:center; padding:24px;} }
.sheet{background:var(--card); width:100%; max-width:620px; max-height:92vh; display:flex; flex-direction:column;
  border-radius:3px 3px 0 0; border-top:3px solid var(--blue);}
@media(min-width:700px){ .sheet{border-radius:3px; max-height:88vh;} }
.sheet-sm{max-width:420px;}
.sheet-hd{display:flex; align-items:center; gap:10px; padding:11px 14px; border-bottom:1px solid var(--rule);}
.sheet-hd .lbl{flex:1;}
.sheet-bd{padding:16px 16px 6px; overflow:auto;}
.sheet-ft{display:flex; justify-content:flex-end; gap:8px; padding:12px 14px; border-top:1px solid var(--rule); background:#F3F5F0;}
.code{display:block; font-family:var(--mono); font-size:11.5px; background:#EDF0EA; border:1px solid var(--rule-2);
  padding:6px 8px; border-radius:2px; margin:7px 0; letter-spacing:.04em; color:var(--ink-2);}

.tally{display:flex; gap:6px; flex-wrap:wrap; margin:12px 0 8px;}
.tally-i{font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase;
  padding:3px 7px; border-radius:2px; background:#E7EAE4; color:var(--ink-2);}
.tally-ok{background:var(--blue-t); color:var(--blue-d);}
.tally-bad{background:var(--rust-t); color:var(--rust);}
.plan{list-style:none; margin:0; padding:0; border:1px solid var(--rule-2); border-radius:2px; max-height:240px; overflow:auto;}
.plan li{display:flex; align-items:baseline; gap:9px; padding:5px 9px; border-bottom:1px solid var(--rule-2); font-size:12px;}
.plan li:last-child{border-bottom:0;}
.plan-n{width:22px; flex:none; font-size:10px; color:var(--steel-2); text-align:right;}
.plan-s{flex:none; font-weight:600; letter-spacing:.04em;}
.plan-w{color:var(--steel); font-size:11.5px;}
.plan-ok .plan-s{color:var(--blue-d);}
.plan-bad{background:#FBF1EF;} .plan-bad .plan-w{color:var(--rust);}

/* empty + footer */
.empty{text-align:center;}
.empty-h{font-family:var(--mono); font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; margin:0 0 6px;}
.empty-a{display:flex; gap:8px; justify-content:center; margin-top:14px; flex-wrap:wrap;}
.foot{display:flex; align-items:center; gap:6px; padding:9px 16px; background:var(--card);
  border-top:1px solid var(--rule); position:sticky; bottom:0; flex-wrap:wrap;}
.foot-s{font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--steel-2);}

.toast{position:fixed; left:50%; transform:translateX(-50%); bottom:60px; z-index:80;
  background:var(--ink); color:#F4F5F1; padding:9px 14px; border-radius:2px;
  font-family:var(--mono); font-size:11px; letter-spacing:.06em; max-width:88vw; text-align:center;}
.toast-bad{background:var(--rust);}
.spin{animation:sp 1s linear infinite; display:inline-block; vertical-align:-2px;}
@keyframes sp{to{transform:rotate(360deg);}}
@media(prefers-reduced-motion:reduce){ .app *{transition:none !important; animation:none !important;} }
`;
