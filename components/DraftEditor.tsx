"use client";

import { useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { PencilSimple, FloppyDisk, ArrowCounterClockwise } from "@phosphor-icons/react";
import { SUBJECT_MAX, BODY_MAX } from "@/lib/agent/draftEdit";
// Browser-safe only: refine.ts pulls in the Groq SDK and must never be imported here.
import {
    REFINE_ACTIONS,
    REFINE_LABELS,
    SELECTION_MAX,
    CONTEXT_MAX,
    trimSelection,
    describeFactChange,
    type RefineAction,
    type FactCheck,
} from "@/lib/agent/refineShared";

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

// A rewrite waiting for the person to Replace or Dismiss it. Nothing is applied
// until they choose, and `original` lets Replace check the text underneath hasn't changed.
interface Suggestion {
    action: RefineAction;
    start: number;
    end: number;
    original: string;
    text: string;
    facts: FactCheck | null;
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
    // Selection actions: the highlighted range, a rewrite in flight, the suggestion
    // waiting for Replace or Dismiss, and the last failure.
    const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
    const [refining, setRefining] = useState<RefineAction | null>(null);
    const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
    const [refineError, setRefineError] = useState<string | null>(null);
    const [lastAction, setLastAction] = useState<RefineAction | null>(null);

    const canEdit = EDITABLE_TOOLS.includes(toolName) && typeof subject === "string" && typeof body === "string";
    const isEditing = editing && !locked;

    const dirty = draft.subject.trim() !== saved.subject.trim() || draft.body.trim() !== saved.body.trim();
    const editedByYou = saved.subject.trim() !== original.subject.trim() || saved.body.trim() !== original.body.trim();
    const differsFromOriginal = draft.subject.trim() !== original.subject.trim() || draft.body.trim() !== original.body.trim();

    const subjectLength = draft.subject.trim().length;
    const bodyLength = draft.body.trim().length;
    const subjectProblem = subjectLength === 0 ? "The subject can't be empty." : subjectLength > SUBJECT_MAX ? `The subject is ${subjectLength - SUBJECT_MAX} characters too long.` : null;
    const bodyProblem = bodyLength === 0 ? "The message can't be empty." : bodyLength > BODY_MAX ? `The message is ${bodyLength - BODY_MAX} characters too long.` : null;
    // While a rewrite is in flight or waiting for a decision, the text is frozen and
    // Save is off, so the offsets the suggestion refers to can't go stale.
    const refineBusy = Boolean(refining || suggestion);
    const canSave = !saving && !refineBusy && dirty && !subjectProblem && !bodyProblem;

    const selectedLength = selection ? selection.end - selection.start : 0;
    const selectionTooLong = selectedLength > SELECTION_MAX;
    const factWarning = suggestion
        ? suggestion.facts
            ? describeFactChange(suggestion.facts)
            : "Couldn't check whether numbers or addresses changed. Read the rewrite carefully."
        : null;

    const clearRefine = () => {
        setSelection(null);
        setRefining(null);
        setSuggestion(null);
        setRefineError(null);
        setLastAction(null);
    };

    const startEdit = () => {
        setDraft(saved);
        setError(null);
        setNote(null);
        clearRefine();
        setEditing(true);
        onStateChange({ editing: true, saving: false });
    };

    const cancel = () => {
        if (saving) return;
        setEditing(false);
        setDraft(saved);
        setError(null);
        clearRefine();
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
            clearRefine();
            setEditing(false);
            setSaving(false);
            onStateChange({ editing: false, saving: false });
        } catch {
            failed("Couldn't reach the server, so the edit may not have been saved. Check your connection and try again.");
        }
    };

    const onBodySelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
        if (refineBusy) return;
        const target = event.currentTarget;
        setSelection(trimSelection(draft.body, target.selectionStart, target.selectionEnd));
    };

    const runRefine = async (action: RefineAction) => {
        if (!selection || refining) return;

        const { start, end } = selection;
        const original = draft.body.slice(start, end);
        if (original.length > SELECTION_MAX) return;

        setSuggestion(null);
        setRefining(action);
        setLastAction(action);
        setRefineError(null);

        const failed = (message: string) => {
            setRefineError(message);
            setRefining(null);
        };

        try {
            const res = await fetch(`/api/actions/${actionId}/refine`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action,
                    selection: original,
                    before: draft.body.slice(Math.max(0, start - CONTEXT_MAX), start),
                    after: draft.body.slice(end, end + CONTEXT_MAX),
                }),
            });

            const isJson = (res.headers.get("content-type") ?? "").includes("application/json");

            if (!isJson) {
                failed(
                    res.status === 404
                        ? "The rewrite endpoint wasn't found (HTTP 404). Restart the server or redeploy, then try again."
                        : `The server sent an unexpected response (HTTP ${res.status}), so there is no suggestion. Try again.`
                );
                return;
            }

            const data = await res.json();

            if (!res.ok || typeof data.suggestion !== "string") {
                failed(typeof data.error === "string" ? data.error : "I couldn't get a suggestion. Try again.");
                return;
            }

            setSuggestion({
                action,
                start,
                end,
                original,
                text: data.suggestion,
                facts: data.facts && typeof data.facts.changed === "boolean" ? data.facts : null,
            });
            setRefining(null);
        } catch {
            failed("Couldn't reach the server, so there is no suggestion. Check your connection and try again.");
        }
    };

    const replaceSelection = () => {
        if (!suggestion) return;

        // The text is frozen while a suggestion is open, but check anyway: applying
        // a rewrite over text that has since changed would corrupt the draft.
        if (draft.body.slice(suggestion.start, suggestion.end) !== suggestion.original) {
            setRefineError("The text changed since this suggestion was made, so I haven't applied it. Select the passage again.");
            setSuggestion(null);
            setSelection(null);
            return;
        }

        setDraft({ ...draft, body: draft.body.slice(0, suggestion.start) + suggestion.text + draft.body.slice(suggestion.end) });
        setSuggestion(null);
        setSelection(null);
        setLastAction(null);
        setRefineError(null);
    };

    const dismissSuggestion = () => {
        setSuggestion(null);
        setSelection(null);
        setLastAction(null);
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
                    readOnly={refineBusy}
                    onSelect={onBodySelect}
                    onChange={(e) => {
                        setDraft({ ...draft, body: e.target.value });
                        setSelection(null);
                    }}
                    onKeyDown={onKeyDown}
                    className={`${FIELD} resize-y`}
                />
                {bodyProblem && <div className="text-[10px] text-red-400 font-mono mt-1">{bodyProblem}</div>}

                {selection && !refineBusy && (
                    <div role="toolbar" aria-label="Rewrite selected text" className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] text-neutral-500 font-mono">{selectedLength} selected</span>
                        {REFINE_ACTIONS.map((action) => (
                            <button
                                key={action}
                                type="button"
                                disabled={selectionTooLong || saving}
                                onClick={() => void runRefine(action)}
                                className="px-2 py-1 rounded-md bg-black border border-neutral-700/60 text-neutral-300 text-[10px] font-bold uppercase tracking-wider hover:border-yellow-400/60 hover:text-neutral-100 transition-all disabled:opacity-40 font-mono"
                            >
                                {REFINE_LABELS[action]}
                            </button>
                        ))}
                        {selectionTooLong && (
                            <span className="text-[10px] text-red-400 font-mono">Selection too long (max {SELECTION_MAX}). Select a shorter passage.</span>
                        )}
                    </div>
                )}

                {refining && (
                    <div role="status" className="mt-2 text-[10px] text-neutral-500 font-mono">
                        Rewriting ({REFINE_LABELS[refining].toLowerCase()})...
                    </div>
                )}

                {refineError && !refining && (
                    <div role="alert" className="mt-2 text-[10px] text-red-400/80 font-mono bg-red-950/30 border border-red-900 p-2 leading-relaxed">
                        {refineError}
                        {lastAction && selection && (
                            <button
                                type="button"
                                onClick={() => void runRefine(lastAction)}
                                className="ml-2 underline underline-offset-2 uppercase tracking-wider text-red-300 hover:text-red-100"
                            >
                                Try again
                            </button>
                        )}
                    </div>
                )}

                {suggestion && (
                    <div role="region" aria-label="Suggested rewrite" className="mt-2 space-y-2 border border-neutral-700/60 bg-black p-3 rounded-lg">
                        <div className="text-[10px] text-neutral-500 font-mono uppercase tracking-wider">
                            Suggested rewrite ({REFINE_LABELS[suggestion.action]})
                        </div>
                        <div>
                            <div className={LABEL}>Before</div>
                            <div className="text-xs text-neutral-400 font-mono whitespace-pre-wrap leading-relaxed">{suggestion.original}</div>
                        </div>
                        <div>
                            <div className={LABEL}>After</div>
                            <div className="text-xs text-neutral-100 font-mono whitespace-pre-wrap leading-relaxed">{suggestion.text}</div>
                        </div>
                        {factWarning && (
                            <div role="note" className="text-[10px] text-yellow-400/90 font-mono bg-yellow-400/5 border border-yellow-400/30 p-2 leading-relaxed">
                                {factWarning}
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={replaceSelection}
                                className="px-3 py-1.5 rounded-lg bg-neutral-100 border border-neutral-100 text-black text-xs font-bold uppercase tracking-wider hover:bg-white active:scale-[0.98] transition-all font-mono"
                            >
                                Replace
                            </button>
                            <button
                                type="button"
                                onClick={dismissSuggestion}
                                className="px-3 py-1.5 rounded-lg bg-black border border-neutral-700/60 text-neutral-400 text-xs font-bold uppercase tracking-wider hover:border-neutral-500 hover:text-neutral-200 transition-all font-mono"
                            >
                                Dismiss
                            </button>
                            <button
                                type="button"
                                onClick={() => void runRefine(suggestion.action)}
                                className="text-[10px] text-neutral-500 hover:text-neutral-200 font-mono uppercase tracking-wider transition-colors"
                            >
                                Try again
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="text-[10px] text-neutral-600 font-mono leading-relaxed">
                Select text in the message to rewrite it. Recipients can&apos;t be edited here. Emails send as plain text. Approve is off until you save or cancel.
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