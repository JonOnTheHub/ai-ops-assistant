"use client";

import { useState, type KeyboardEvent } from "react";
import { PencilSimple, FloppyDisk, ArrowCounterClockwise } from "@phosphor-icons/react";
import { SUBJECT_MAX, BODY_MAX } from "@/lib/agent/draftEdit";

// Edit the subject and body of a pending email or broadcast before approving.
//
// What this guards: the approve route sends the STORED action, so an edit only
// counts once it is saved on the server. Edits are therefore explicit (Save
// edits), the card disables Approve while edits are unsaved, and what is shown
// after a save is what the server returned, cleaned to plain text, not what
// was typed. Recipients are never shown as editable: the server rejects them
// outright (lib/agent/draftEdit.ts), and this component doesn't offer them.

const EDITABLE_TOOLS = ["sendEmail", "sendBroadcast"];

export interface DraftEditorState {
    editing: boolean;
    saving: boolean;
}

interface Draft {
    subject: string;
    body: string;
}

interface DraftEditorProps {
    actionId: string;
    toolName: string;
    subject?: string;
    body?: string;
    // The card is approving, rejecting or finished: no editing.
    locked: boolean;
    onStateChange: (state: DraftEditorState) => void;
}

const LABEL = "text-neutral-600 uppercase text-[10px] tracking-wider";
const FIELD =
    "w-full bg-neutral-950 border border-neutral-800 text-neutral-200 text-xs font-mono p-2 leading-relaxed outline-none focus:border-yellow-400/60 disabled:opacity-60";

export function DraftEditor({ actionId, toolName, subject, body, locked, onStateChange }: DraftEditorProps) {
    // The model's own proposal, kept so "Reset to original" can always return to it.
    const [original] = useState<Draft>(() => ({ subject: subject ?? "", body: body ?? "" }));
    const [saved, setSaved] = useState<Draft>(original);
    const [draft, setDraft] = useState<Draft>(original);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const canEdit = EDITABLE_TOOLS.includes(toolName) && typeof subject === "string" && typeof body === "string";
    const isEditing = editing && !locked;

    const dirty = draft.subject.trim() !== saved.subject.trim() || draft.body.trim() !== saved.body.trim();
    const editedByYou = saved.subject.trim() !== original.subject.trim() || saved.body.trim() !== original.body.trim();
    const differsFromOriginal = draft.subject.trim() !== original.subject.trim() || draft.body.trim() !== original.body.trim();

    const subjectLength = draft.subject.trim().length;
    const bodyLength = draft.body.trim().length;
    const subjectProblem = subjectLength === 0 ? "The subject can't be empty." : subjectLength > SUBJECT_MAX ? `The subject is ${subjectLength - SUBJECT_MAX} characters too long.` : null;
    const bodyProblem = bodyLength === 0 ? "The message can't be empty." : bodyLength > BODY_MAX ? `The message is ${bodyLength - BODY_MAX} characters too long.` : null;
    const canSave = !saving && dirty && !subjectProblem && !bodyProblem;

    const startEdit = () => {
        setDraft(saved);
        setError(null);
        setNote(null);
        setEditing(true);
        onStateChange({ editing: true, saving: false });
    };

    const cancel = () => {
        if (saving) return;
        setEditing(false);
        setDraft(saved);
        setError(null);
        onStateChange({ editing: false, saving: false });
    };

    const save = async () => {
        if (!canSave) return;

        const changes: Partial<Draft> = {};
        if (draft.subject.trim() !== saved.subject.trim()) changes.subject = draft.subject;
        if (draft.body.trim() !== saved.body.trim()) changes.body = draft.body;

        setSaving(true);
        setError(null);
        setNote(null);
        onStateChange({ editing: true, saving: true });

        const failed = (message: string) => {
            setError(message);
            setSaving(false);
            onStateChange({ editing: true, saving: false });
        };

        try {
            const res = await fetch(`/api/actions/${actionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(changes),
            });

            const isJson = (res.headers.get("content-type") ?? "").includes("application/json");

            // Our handler always answers in JSON. Anything else means the request
            // never reached it (for example the framework's own 404 page).
            if (!isJson) {
                failed(
                    res.status === 404
                        ? "The save endpoint wasn't found (HTTP 404), so nothing was saved. Restart the server or redeploy, then try again."
                        : `The server sent an unexpected response (HTTP ${res.status}), so I can't tell whether the edit was saved. Check the draft before approving.`
                );
                return;
            }

            const data = await res.json();

            if (!res.ok) {
                failed(typeof data.error === "string" ? data.error : "I couldn't save the edit, so the draft is unchanged.");
                return;
            }

            // Show what the SERVER stored, not what was typed: it has been cleaned
            // to plain text, and that cleaned text is what will be sent.
            const next: Draft = {
                subject: typeof data.subject === "string" ? data.subject : draft.subject,
                body: typeof data.body === "string" ? data.body : draft.body,
            };

            if (next.subject.trim() !== draft.subject.trim() || next.body.trim() !== draft.body.trim()) {
                setNote("Saved as plain text: emails can't show formatting, so markup such as **bold** was removed.");
            }

            setSaved(next);
            setDraft(next);
            setEditing(false);
            setSaving(false);
            onStateChange({ editing: false, saving: false });
        } catch {
            failed("Couldn't reach the server, so the edit may not have been saved. Check your connection and try again.");
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
        }
    };

    // ── Read view: identical to how the card always showed the draft ──────────
    if (!isEditing) {
        return (
            <>
                {saved.subject && (
                    <div className="text-neutral-400">
                        <span className={LABEL}>Subject </span>
                        <span className="text-neutral-200">{saved.subject}</span>
                    </div>
                )}
                {saved.body && (
                    <div className="text-neutral-400 text-xs bg-neutral-950 p-3 leading-relaxed border border-neutral-800 mt-2 whitespace-pre-wrap">
                        {saved.body}
                    </div>
                )}
                {canEdit && !locked && (
                    <div className="flex items-center gap-3 pt-1">
                        <button
                            type="button"
                            onClick={startEdit}
                            className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-200 font-mono uppercase tracking-wider transition-colors"
                        >
                            <PencilSimple size={11} />
                            Edit draft
                        </button>
                        {editedByYou && (
                            <span className="text-[10px] text-yellow-400/80 font-mono uppercase tracking-wider">Edited by you</span>
                        )}
                    </div>
                )}
                {note && <div className="text-[10px] text-neutral-500 font-mono leading-relaxed">{note}</div>}
            </>
        );
    }

    // ── Edit view ─────────────────────────────────────────────────────────────
    return (
        <div role="group" aria-label="Edit draft" className="space-y-2 pt-1">
            <div>
                <div className="flex items-baseline justify-between">
                    <label htmlFor={`subject-${actionId}`} className={LABEL}>Subject</label>
                    <span className={`text-[10px] font-mono ${subjectProblem ? "text-red-400" : "text-neutral-600"}`}>{subjectLength} / {SUBJECT_MAX}</span>
                </div>
                <input
                    id={`subject-${actionId}`}
                    aria-label="Subject"
                    value={draft.subject}
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                    onKeyDown={onKeyDown}
                    className={FIELD}
                />
                {subjectProblem && <div className="text-[10px] text-red-400 font-mono mt-1">{subjectProblem}</div>}
            </div>

            <div>
                <div className="flex items-baseline justify-between">
                    <label htmlFor={`body-${actionId}`} className={LABEL}>Message</label>
                    <span className={`text-[10px] font-mono ${bodyProblem ? "text-red-400" : "text-neutral-600"}`}>{bodyLength} / {BODY_MAX}</span>
                </div>
                <textarea
                    id={`body-${actionId}`}
                    aria-label="Message body"
                    value={draft.body}
                    rows={9}
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    onKeyDown={onKeyDown}
                    className={`${FIELD} resize-y`}
                />
                {bodyProblem && <div className="text-[10px] text-red-400 font-mono mt-1">{bodyProblem}</div>}
            </div>

            <div className="text-[10px] text-neutral-600 font-mono leading-relaxed">
                Recipients can&apos;t be edited here. Emails send as plain text. Approve is off until you save or cancel.
            </div>

            {error && (
                <div role="alert" className="text-[10px] text-red-400/80 font-mono bg-red-950/30 border border-red-900 p-2 leading-relaxed">
                    {error}
                </div>
            )}

            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!canSave}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-100 border border-neutral-100 text-black text-xs font-bold uppercase tracking-wider hover:bg-white active:scale-[0.98] transition-all disabled:opacity-40 font-mono"
                >
                    <FloppyDisk size={13} weight="fill" />
                    {saving ? "Saving..." : "Save edits"}
                </button>
                <button
                    type="button"
                    onClick={cancel}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-lg bg-black border border-neutral-700/60 text-neutral-400 text-xs font-bold uppercase tracking-wider hover:border-neutral-500 hover:text-neutral-200 transition-all disabled:opacity-40 font-mono"
                >
                    Cancel
                </button>
                {differsFromOriginal && (
                    <button
                        type="button"
                        onClick={() => {
                            setDraft(original);
                            setError(null);
                        }}
                        disabled={saving}
                        className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-200 font-mono uppercase tracking-wider transition-colors disabled:opacity-40"
                    >
                        <ArrowCounterClockwise size={11} />
                        Reset to original
                    </button>
                )}
            </div>
        </div>
    );
}