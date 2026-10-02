import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAnnounce } from "../components/Announcer";
import { Icon } from "../components/icons";
import type { EditorView } from "../editor/GuideEditor";
import type { CommentThread, ReviewComment } from "../library-bridge";
import { formatDateTime } from "../library/dates";

/** The whole guide, in the "About" choice. */
const WHOLE_GUIDE = "";
const MAX_COMMENT = 5_000;

export interface CommentsPanelProps {
  threads: CommentThread[];
  view: EditorView;
  /** Resolves to whether it was saved, so the text box empties only then. */
  onAdd: (stepId: string | null, replyTo: string | null, text: string) => Promise<boolean>;
  onResolve: (thread: CommentThread, resolved: boolean) => Promise<void>;
  onDelete: (comment: ReviewComment) => Promise<void>;
  onClose: () => void;
}

/**
 * Review comments (docs/spec/04-editor.md#review-comments): threads on a step or the whole guide,
 * with replies, resolved and reopened. They work on a guide someone else is editing too.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const { t } = useTranslation();
  const { view, threads } = props;
  const announce = useAnnounce();
  const [about, setAbout] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const aboutId = useId();
  const textId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Opened on purpose, so typing goes straight into a new comment rather than after the editor.
  useEffect(() => textRef.current?.focus(), []);

  /** After a change that may remove the focused control (a thread hidden once resolved). */
  const change = async (run: () => Promise<void>) => {
    await run();
    window.requestAnimationFrame(() => {
      if (!panelRef.current?.contains(document.activeElement)) headingRef.current?.focus();
    });
  };

  // New comments are about the step on screen until another choice is made.
  const target = about ?? view.selectedStepId ?? WHOLE_GUIDE;
  const position = new Map(view.steps.map((step, index) => [step.id, index]));
  const label = (stepId: string | null) => {
    if (stepId === null) return t("comments.wholeGuide");
    const step = view.steps.find((found) => found.id === stepId);
    if (!step) return t("comments.deletedStep");
    const number = view.numbers.get(stepId);
    return number === undefined
      ? t("comments.block", { text: step.actionText })
      : t("comments.step", { number, text: step.actionText });
  };
  const order = (thread: CommentThread) =>
    thread.stepId === null ? -1 : (position.get(thread.stepId) ?? Number.MAX_SAFE_INTEGER);
  const sorted = [...threads].sort((left, right) => order(left) - order(right));
  const resolvedCount = threads.filter((thread) => thread.resolved).length;
  const shown = sorted.filter((thread) => showResolved || !thread.resolved);

  const add = async () => {
    if (await props.onAdd(target === WHOLE_GUIDE ? null : target, null, text)) {
      setText("");
      announce(t("comments.added"));
    }
    // The Comment button disables once the box is empty; stay in the box for the next one.
    textRef.current?.focus();
  };

  return (
    // Escape closes the panel from anywhere in it, as a dialog would.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      ref={panelRef}
      aria-label={t("comments.title")}
      // On a narrow window (200% zoom) it lies over the editor instead of squeezing it.
      className="flex w-[340px] max-w-full shrink-0 flex-col border-l border-panel bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-xl"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className="flex items-center gap-2 border-b border-panel px-4 py-3">
        <h2 ref={headingRef} tabIndex={-1} className="flex-1 font-heading text-lg text-navy">
          {t("comments.title")}
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("comments.close")}
          onClick={props.onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <form
        className="flex flex-col gap-2 border-b border-panel px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label htmlFor={aboutId} className="text-xs font-semibold text-secondary">
          {t("comments.about")}
        </label>
        <select
          id={aboutId}
          className="field"
          value={target}
          onChange={(event) => setAbout(event.currentTarget.value)}
        >
          <option value={WHOLE_GUIDE}>{t("comments.wholeGuide")}</option>
          {view.steps.map((step) => (
            <option key={step.id} value={step.id}>
              {label(step.id)}
            </option>
          ))}
        </select>
        <label htmlFor={textId} className="text-xs font-semibold text-secondary">
          {t("comments.new")}
        </label>
        <textarea
          ref={textRef}
          id={textId}
          className="field min-h-20 resize-y"
          placeholder={t("comments.placeholder")}
          maxLength={MAX_COMMENT}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn btn-primary self-end"
          disabled={text.trim().length === 0}
        >
          {t("comments.add")}
        </button>
      </form>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {resolvedCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              className="size-4 accent-blue"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.currentTarget.checked)}
            />
            {t("comments.showResolved", { count: resolvedCount })}
          </label>
        )}
        {shown.length === 0 && (
          <p className="text-sm text-secondary">
            {threads.length === 0 ? t("comments.none") : t("comments.allResolved")}
          </p>
        )}
        {shown.map((thread) => (
          <Thread
            key={thread.id}
            thread={thread}
            about={label(thread.stepId)}
            current={thread.stepId !== null && thread.stepId === view.selectedStepId}
            onShow={
              thread.stepId !== null && position.has(thread.stepId)
                ? () => view.showStep(thread.stepId as string)
                : undefined
            }
            onReply={async (reply) => {
              const saved = await props.onAdd(null, thread.id, reply);
              if (saved) announce(t("comments.replied"));
              return saved;
            }}
            onResolve={(resolved) => void change(() => props.onResolve(thread, resolved))}
            onDelete={(comment) => void change(() => props.onDelete(comment))}
          />
        ))}
      </div>
    </aside>
  );
}

function Thread(props: {
  thread: CommentThread;
  about: string;
  current: boolean;
  onShow: (() => void) | undefined;
  onReply: (text: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => void;
  onDelete: (comment: ReviewComment) => void;
}) {
  const { t } = useTranslation();
  const { thread } = props;
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const replyId = useId();
  const replyButton = useRef<HTMLButtonElement>(null);
  const wasReplying = useRef(false);

  // Closing the reply box (sent or cancelled) puts focus back on Reply.
  useEffect(() => {
    if (wasReplying.current && !replying) replyButton.current?.focus();
    wasReplying.current = replying;
  }, [replying]);

  const comment = (item: ReviewComment, deletable: boolean) => (
    <li key={item.id} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 text-xs text-secondary">
        <span className="font-semibold text-navy">{item.by}</span>
        <span aria-hidden="true">·</span>
        <span className="flex-1">{formatDateTime(item.at)}</span>
        {item.mine && deletable && (
          <button
            type="button"
            className="icon-btn size-7"
            aria-label={t("comments.delete")}
            onClick={() => props.onDelete(item)}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{item.text}</p>
    </li>
  );

  return (
    <article
      aria-label={props.about}
      className={`card flex flex-col gap-2 p-3 ${thread.resolved ? "opacity-75" : ""} ${props.current ? "border-blue" : ""}`}
    >
      {props.onShow ? (
        <button
          type="button"
          className="truncate text-left text-xs font-bold text-link hover:underline"
          onClick={props.onShow}
        >
          {props.about}
        </button>
      ) : (
        <span className="truncate text-xs font-bold text-secondary">{props.about}</span>
      )}
      <ul className="flex flex-col gap-2.5">
        {comment(thread, thread.replies.length === 0)}
        {thread.replies.map((item) => comment(item, true))}
      </ul>
      {thread.resolved && (
        <p className="text-xs text-secondary">
          {t("comments.resolvedBy", {
            name: thread.resolved.by,
            when: formatDateTime(thread.resolved.at),
          })}
        </p>
      )}
      {replying && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onReply(reply).then((saved) => {
              if (!saved) return;
              setReply("");
              setReplying(false);
            });
          }}
        >
          <label htmlFor={replyId} className="sr-only">
            {t("comments.reply")}
          </label>
          {/* Escape leaves the reply, not the whole panel. */}
          <textarea
            id={replyId}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setReplying(false);
            }}
            // Opened on purpose, so typing goes straight in.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="field min-h-16 resize-y"
            maxLength={MAX_COMMENT}
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setReplying(false)}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={reply.trim().length === 0}>
              {t("comments.reply")}
            </button>
          </div>
        </form>
      )}
      {!replying && (
        <div className="flex gap-2">
          {!thread.resolved && (
            <button
              ref={replyButton}
              type="button"
              className="btn"
              onClick={() => setReplying(true)}
            >
              {t("comments.reply")}
            </button>
          )}
          <button type="button" className="btn" onClick={() => props.onResolve(!thread.resolved)}>
            {thread.resolved ? t("comments.reopen") : t("comments.resolve")}
          </button>
        </div>
      )}
    </article>
  );
}
