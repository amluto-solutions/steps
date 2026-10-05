import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGES,
  mainLanguage,
  passwordProblem,
  type GuideHistory,
  type GuideLock,
  type Who,
} from "@amluto-steps/core";

import { Icon } from "../components/icons";
import { errorMessage } from "../errors";
import type { GuideStats, LibraryBridge, LibraryInfo } from "../library-bridge";
import { ModalDialog } from "../ModalDialog";
import { policy } from "../settings/policy";
import { formatDate, formatDateTime } from "./dates";
import type { GuideLocks } from "./guide-locks";

/**
 * The screens for password locks on guides (docs/spec/03-data-and-sharing.md#password-locks):
 * locking, the password prompt, the locked guides left over from a batch, typing the number to
 * confirm a delete of several, and Properties. `LockHost` is drawn once in the app; the `ask…`
 * functions open its screens from anywhere and answer when they close, as `askConfirm` does.
 */

export const GuideLocksContext = createContext<GuideLocks | null>(null);
export const useGuideLocks = () => useContext(GuideLocksContext);

/** A locked guide, as a screen names it. */
export interface LockTarget {
  libraryId: string;
  guideId: string;
  title: string;
  locked: { by: string; at: string };
}

type Request =
  | { kind: "unlock"; target: LockTarget; action: string; done: (open: boolean) => void }
  | {
      kind: "password";
      title: string;
      body: string | null;
      yes: string;
      done: (password: string | null) => void;
    }
  | { kind: "count"; title: string; count: number; yes: string; done: (sure: boolean) => void }
  | {
      kind: "list";
      targets: LockTarget[];
      body: string;
      act: (target: LockTarget) => Promise<void>;
      done: () => void;
    }
  | {
      kind: "properties";
      libraryId: string;
      guideId: string;
      done: () => void;
    };

let show: ((request: Request | null) => void) | null = null;
const ask = <T,>(make: (done: (value: T) => void) => Request, fallback: T): Promise<T> =>
  show ? new Promise<T>((done) => show?.(make(done))) : Promise.resolve(fallback);

/**
 * Asks for a locked guide's password, unlocking it for this session; true once it's open.
 * `action` is the button ("Unlock", "Move to Bin"…).
 */
export const askUnlock = (target: LockTarget, action: string) =>
  ask<boolean>((done) => ({ kind: "unlock", target, action, done }), false);

/** A new password, typed twice; null when cancelled. */
export const askNewPassword = (title: string, body: string | null, yes: string) =>
  ask<string | null>((done) => ({ kind: "password", title, body, yes, done }), null);

/** Typing the number of guides to confirm deleting several (04/10/2026). */
export const askCount = (title: string, count: number, yes: string) =>
  ask<boolean>((done) => ({ kind: "count", title, count, yes, done }), false);

/** The locked guides a batch left: each can be opened with its password and then done. */
export const showLockedList = (
  targets: LockTarget[],
  body: string,
  act: (target: LockTarget) => Promise<void>,
) =>
  targets.length === 0
    ? Promise.resolve()
    : ask<undefined>(
        (done) => ({ kind: "list", targets, body, act, done: () => done(undefined) }),
        undefined,
      );

export const showProperties = (libraryId: string, guideId: string) =>
  ask<undefined>(
    (done) => ({ kind: "properties", libraryId, guideId, done: () => done(undefined) }),
    undefined,
  );

/** "Locked by Robin Hale on 04/10/2026". */
export function useLockedBy() {
  const { t } = useTranslation();
  return (locked: { by: string; at: string }) =>
    t("locks.lockedBy", {
      name: locked.by,
      date: locked.at ? formatDate(new Date(locked.at)) : "",
    });
}

const Backdrop = ({ children }: { children: ReactNode }) => (
  <div className="fixed inset-0 z-[900] grid items-center justify-items-center bg-scrim/50 p-4">
    {children}
  </div>
);

/** A password box, with its own label; never filled in by the browser. */
function PasswordField({
  label,
  value,
  onChange,
  ref,
  invalid,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-navy">
      {label}
      <input
        ref={ref}
        type="password"
        className="field"
        autoComplete="new-password"
        maxLength={400}
        value={value}
        aria-invalid={invalid || undefined}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function Buttons(props: { yes: string; onCancel: () => void; busy?: boolean; cancel?: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 flex justify-end gap-3">
      <button type="button" className="btn" onClick={props.onCancel}>
        {props.cancel ?? t("common.cancel")}
      </button>
      <button type="submit" className="btn btn-dark" disabled={props.busy}>
        {props.yes}
      </button>
    </div>
  );
}

function UnlockDialog(props: {
  locks: GuideLocks;
  target: LockTarget;
  action: string;
  onDone: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const lockedBy = useLockedBy();
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const { libraryId, guideId } = props.target;
      const result = await props.locks.unlock(libraryId, guideId, password);
      if (result.kind === "unlocked") props.onDone(true);
      else {
        setProblem(
          result.kind === "wait"
            ? t("locks.wait", { seconds: Math.ceil(result.ms / 1000) })
            : t("locks.wrong"),
        );
        setPassword("");
        inputRef.current?.focus();
      }
    } catch (error) {
      setProblem(errorMessage(error, t("library.actionFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Backdrop>
      <ModalDialog
        labelledBy="unlock-title"
        describedBy="unlock-body"
        initialFocus={inputRef}
        onEscape={() => props.onDone(false)}
        className="card w-full max-w-md p-6"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id="unlock-title" className="flex items-center gap-2 font-heading text-xl text-navy">
            <Icon name="lock" size={18} />
            {t("locks.unlockTitle", { title: props.target.title })}
          </h2>
          <p id="unlock-body" className="mt-2 text-sm text-secondary">
            {lockedBy(props.target.locked)}
          </p>
          <div className="mt-4">
            <PasswordField
              label={t("locks.password")}
              value={password}
              onChange={setPassword}
              ref={inputRef}
              invalid={problem !== null}
              {...(problem ? { describedBy: "unlock-problem" } : {})}
            />
          </div>
          {problem && (
            <p id="unlock-problem" role="alert" className="mt-2 text-sm text-danger">
              {problem}
            </p>
          )}
          <Buttons
            yes={props.action}
            busy={busy || !password}
            onCancel={() => props.onDone(false)}
          />
        </form>
      </ModalDialog>
    </Backdrop>
  );
}

function NewPasswordDialog(props: {
  title: string;
  body: string | null;
  yes: string;
  onDone: (password: string | null) => void;
}) {
  const { t } = useTranslation();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recovery = policy().guideLockRecoveryPassword !== null;
  const submit = () => {
    const issue = passwordProblem(first);
    if (issue) setProblem(t(issue === "short" ? "locks.tooShort" : "locks.tooLong"));
    else if (first !== second) setProblem(t("locks.mismatch"));
    else props.onDone(first);
  };
  return (
    <Backdrop>
      <ModalDialog
        labelledBy="lock-title"
        describedBy="lock-body"
        initialFocus={inputRef}
        onEscape={() => props.onDone(null)}
        className="card w-full max-w-lg p-6"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h2 id="lock-title" className="flex items-center gap-2 font-heading text-xl text-navy">
            <Icon name="lock" size={18} />
            {props.title}
          </h2>
          <div id="lock-body" className="mt-3 flex flex-col gap-2 text-sm text-secondary">
            {props.body && <p>{props.body}</p>}
            <p>{t("locks.outsideNote")}</p>
            <p>{t(recovery ? "locks.withRecovery" : "locks.noRecovery")}</p>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <PasswordField
              label={t("locks.password")}
              value={first}
              onChange={setFirst}
              ref={inputRef}
              invalid={problem !== null}
            />
            <PasswordField
              label={t("locks.passwordAgain")}
              value={second}
              onChange={setSecond}
              invalid={problem !== null}
              {...(problem ? { describedBy: "lock-problem" } : {})}
            />
          </div>
          {problem && (
            <p id="lock-problem" role="alert" className="mt-2 text-sm text-danger">
              {problem}
            </p>
          )}
          <Buttons yes={props.yes} onCancel={() => props.onDone(null)} />
        </form>
      </ModalDialog>
    </Backdrop>
  );
}

function CountDialog(props: {
  title: string;
  count: number;
  yes: string;
  onDone: (sure: boolean) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const right = typed.trim() === String(props.count);
  return (
    <Backdrop>
      <ModalDialog
        role="alertdialog"
        labelledBy="count-title"
        describedBy="count-body"
        initialFocus={inputRef}
        onEscape={() => props.onDone(false)}
        className="card w-full max-w-md p-6"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (right) props.onDone(true);
          }}
        >
          <h2 id="count-title" className="font-heading text-xl text-navy">
            {props.title}
          </h2>
          <p id="count-body" className="mt-3 text-secondary">
            {t("locks.countBody", { count: props.count })}
          </p>
          <label className="mt-4 flex flex-col gap-1.5 text-sm text-navy">
            {t("locks.countLabel")}
            <input
              ref={(element) => {
                inputRef.current = element;
              }}
              className="field w-32"
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
            />
          </label>
          <Buttons yes={props.yes} busy={!right} onCancel={() => props.onDone(false)} />
        </form>
      </ModalDialog>
    </Backdrop>
  );
}

/**
 * What a batch left because it was locked (04/10/2026): pick one, give its password, and it's
 * done; the password is also tried on the rest, and any it opens are done too.
 */
function LockedListDialog(props: {
  locks: GuideLocks;
  targets: LockTarget[];
  body: string;
  act: (target: LockTarget) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const lockedBy = useLockedBy();
  const [left, setLeft] = useState(props.targets);
  const [chosen, setChosen] = useState<string | null>(props.targets[0]?.guideId ?? null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [chosen]);

  const submit = async (target: LockTarget) => {
    setBusy(true);
    try {
      const result = await props.locks.unlock(target.libraryId, target.guideId, password);
      if (result.kind !== "unlocked") {
        setMessage({
          text:
            result.kind === "wait"
              ? t("locks.wait", { seconds: Math.ceil(result.ms / 1000) })
              : t("locks.wrong"),
          problem: true,
        });
        return;
      }
      const opened = [target];
      for (const other of left)
        if (
          other.guideId !== target.guideId &&
          (await props.locks.unlockIfMatches(other.libraryId, other.guideId, password))
        )
          opened.push(other);
      const done: string[] = [];
      const failed: string[] = [];
      for (const item of opened) {
        try {
          await props.act(item);
          done.push(item.guideId);
        } catch (error) {
          failed.push(
            t("library.bulk.failed", {
              title: item.title,
              reason: errorMessage(error, t("library.actionFailed")),
            }),
          );
        } finally {
          props.locks.relock(item.libraryId, item.guideId);
        }
      }
      const rest = left.filter((item) => !done.includes(item.guideId));
      setLeft(rest);
      setChosen(rest[0]?.guideId ?? null);
      setPassword("");
      setMessage({
        text: [t("locks.listDone", { count: done.length }), ...failed].join(" "),
        problem: failed.length > 0,
      });
      if (rest.length === 0) closeRef.current?.focus();
    } catch (error) {
      setMessage({ text: errorMessage(error, t("library.actionFailed")), problem: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Backdrop>
      <ModalDialog
        labelledBy="locked-list-title"
        describedBy="locked-list-body"
        initialFocus={left.length ? inputRef : closeRef}
        onEscape={props.onDone}
        className="card flex max-h-[85vh] w-full max-w-xl flex-col p-6"
      >
        <h2
          id="locked-list-title"
          className="flex items-center gap-2 font-heading text-xl text-navy"
        >
          <Icon name="lock" size={18} />
          {t("locks.listTitle", { count: left.length })}
        </h2>
        <p id="locked-list-body" className="mt-2 text-sm text-secondary">
          {left.length ? props.body : t("locks.listAllDone")}
        </p>
        <p
          role={message?.problem ? "alert" : "status"}
          className={`mt-2 min-h-5 text-sm ${message?.problem ? "text-danger" : "text-secondary"}`}
        >
          {message?.text}
        </p>
        <ul className="mt-2 flex min-h-0 flex-col overflow-y-auto rounded-lg border border-panel">
          {left.map((target, index) => (
            <li
              key={target.guideId}
              className={`flex flex-col gap-2 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong className="truncate text-sm text-navy">{target.title}</strong>
                  <span className="text-[13px] text-secondary">{lockedBy(target.locked)}</span>
                </div>
                {chosen !== target.guideId && (
                  <button
                    type="button"
                    className="btn h-8 px-3"
                    onClick={() => {
                      setChosen(target.guideId);
                      setPassword("");
                      setMessage(null);
                    }}
                  >
                    {t("locks.enterPassword")}
                  </button>
                )}
              </div>
              {chosen === target.guideId && (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit(target);
                  }}
                >
                  <div className="flex-1">
                    <PasswordField
                      label={t("locks.passwordFor", { title: target.title })}
                      value={password}
                      onChange={setPassword}
                      ref={inputRef}
                    />
                  </div>
                  <button type="submit" className="btn btn-dark" disabled={busy || !password}>
                    {t("locks.unlockAndDo")}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button ref={closeRef} type="button" className="btn" onClick={props.onDone}>
            {left.length ? t("locks.leaveThem") : t("locks.done")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

const sizeText = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface PropertiesData {
  title: string;
  library: LibraryInfo | undefined;
  guide: { createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string };
  steps: number;
  languages: string[];
  versions: number;
  stats: GuideStats | null;
  history: GuideHistory;
  lock: GuideLock | null;
}

/** Properties (04/10/2026): where a guide is, its history, what's in it, and its lock. */
function PropertiesDialog(props: {
  locks: GuideLocks;
  library: LibraryBridge;
  libraries: LibraryInfo[];
  libraryId: string;
  guideId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [data, setData] = useState<PropertiesData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const { library, libraryId, guideId } = props;
    void (async () => {
      const [doc, versions, stats, history, lock] = await Promise.all([
        library.loadGuide(libraryId, guideId),
        library.listVersions(libraryId, guideId).catch(() => []),
        library.guideStats?.(libraryId, guideId).catch(() => null) ?? Promise.resolve(null),
        props.locks.history(libraryId, guideId),
        props.locks.lockOf(libraryId, guideId),
      ]);
      const guide = (doc.guide ?? {}) as PropertiesData["guide"] & {
        title?: string;
        language?: string;
        translations?: Record<string, unknown>;
      };
      const codes = [
        mainLanguage({ ...(guide.language ? { language: guide.language } : {}) }),
        ...Object.keys(guide.translations ?? {}),
      ];
      if (!live) return;
      setData({
        title: guide.title ?? "",
        library: props.libraries.find((item) => item.id === libraryId),
        guide,
        steps: doc.steps.length,
        languages: [...new Set(codes)].map(
          (code) => LANGUAGES.find((language) => language.code === code)?.name ?? code,
        ),
        versions: versions.length,
        stats,
        history,
        lock,
      });
    })().catch((error: unknown) => {
      if (live) setProblem(errorMessage(error, t("library.actionFailed")));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per guide shown
  }, [props.libraryId, props.guideId]);

  const notRecorded = t("locks.notRecorded");
  const whoText = (who: Who | null | undefined) =>
    who
      ? [
          t("locks.whoOn", { name: who.by, date: who.at ? formatDateTime(who.at) : "" }),
          who.login || who.pc
            ? t("locks.machine", { login: who.login || notRecorded, pc: who.pc || notRecorded })
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : notRecorded;

  const rows: [string, string][] = data
    ? [
        [t("locks.libraryRow"), data.library?.name ?? ""],
        ...(data.library?.path
          ? [[t("locks.folderRow"), data.library.path] as [string, string]]
          : []),
        [
          t("locks.createdRow"),
          data.history.created
            ? whoText(data.history.created)
            : t("locks.whoOn", {
                name: data.guide.createdBy ?? "",
                date: data.guide.createdAt ? formatDateTime(data.guide.createdAt) : "",
              }),
        ],
        [
          t("locks.savedRow"),
          data.history.lastSaved
            ? whoText(data.history.lastSaved)
            : t("locks.whoOn", {
                name: data.guide.updatedBy ?? "",
                date: data.guide.updatedAt ? formatDateTime(data.guide.updatedAt) : "",
              }),
        ],
        [t("locks.savesRow"), t("locks.saves", { count: data.history.saves })],
        [t("locks.versionsRow"), String(data.versions)],
        [t("locks.stepsRow"), String(data.steps)],
        ...(data.stats
          ? [
              [t("locks.picturesRow"), String(data.stats.pictures)] as [string, string],
              [t("locks.sizeRow"), sizeText(data.stats.bytes)] as [string, string],
            ]
          : []),
        [t("locks.languagesRow"), data.languages.join(", ")],
        [t("locks.lockRow"), data.lock ? whoText(data.lock.locked) : t("locks.notLocked")],
      ]
    : [];
  const eventText = (kind: string) =>
    ({
      locked: t("locks.eventLocked"),
      passwordChanged: t("locks.eventPasswordChanged"),
      lockRemoved: t("locks.eventLockRemoved"),
      unlockedWithRecovery: t("locks.eventRecovery"),
      binned: t("locks.eventBinned"),
    })[kind] ?? kind;

  return (
    <Backdrop>
      <ModalDialog
        labelledBy="properties-title"
        initialFocus={closeRef}
        onEscape={props.onDone}
        className="card flex max-h-[85vh] w-full max-w-xl flex-col p-6"
      >
        <h2 id="properties-title" className="font-heading text-xl text-navy">
          {data ? t("locks.propertiesTitle", { title: data.title }) : t("locks.properties")}
        </h2>
        {problem && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {problem}
          </p>
        )}
        <div className="mt-4 min-h-0 overflow-y-auto">
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-secondary">{label}</dt>
                <dd className="min-w-0 break-words text-navy">{value}</dd>
              </div>
            ))}
          </dl>
          {data && data.history.events.length > 0 && (
            <>
              <h3 className="mt-5 font-heading text-base text-navy">{t("locks.eventsTitle")}</h3>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {[...data.history.events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="text-navy">
                    {eventText(event.kind)} <span className="text-secondary">{whoText(event)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data && <p className="mt-4 text-xs text-secondary">{t("locks.savesNote")}</p>}
        </div>
        <div className="mt-5 flex justify-end">
          <button ref={closeRef} type="button" className="btn" onClick={props.onDone}>
            {t("common.close")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

/** Drawn once in the app, with the wrapped library. */
export function LockHost(props: {
  locks: GuideLocks | null;
  library: LibraryBridge | undefined;
  libraries: LibraryInfo[];
}) {
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    show = setRequest;
    return () => {
      show = null;
    };
  }, []);
  if (!request || !props.locks) return null;
  const close = () => setRequest(null);
  switch (request.kind) {
    case "unlock":
      return (
        <UnlockDialog
          locks={props.locks}
          target={request.target}
          action={request.action}
          onDone={(open) => {
            close();
            request.done(open);
          }}
        />
      );
    case "password":
      return (
        <NewPasswordDialog
          title={request.title}
          body={request.body}
          yes={request.yes}
          onDone={(password) => {
            close();
            request.done(password);
          }}
        />
      );
    case "count":
      return (
        <CountDialog
          title={request.title}
          count={request.count}
          yes={request.yes}
          onDone={(sure) => {
            close();
            request.done(sure);
          }}
        />
      );
    case "list":
      return (
        <LockedListDialog
          locks={props.locks}
          targets={request.targets}
          body={request.body}
          act={request.act}
          onDone={() => {
            close();
            request.done();
          }}
        />
      );
    case "properties":
      return props.library ? (
        <PropertiesDialog
          locks={props.locks}
          library={props.library}
          libraries={props.libraries}
          libraryId={request.libraryId}
          guideId={request.guideId}
          onDone={() => {
            close();
            request.done();
          }}
        />
      ) : null;
  }
}
