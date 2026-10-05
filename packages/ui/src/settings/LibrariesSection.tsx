import { useTranslation } from "react-i18next";
import { Icon } from "../components/icons";
import { errorMessage } from "../errors";
import { isBrowserEdition } from "../recorder-bridge";
import { policy } from "./policy";
import type { SettingsProps } from "./settings-props";

export function LibrariesSection(props: SettingsProps) {
  const { t } = useTranslation();
  const library = props.library;
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await props.onLibrariesChanged();
    } catch (error) {
      props.notify({ kind: "error", text: errorMessage(error, t("settings.libraries.failed")) });
    }
  };
  const browser = isBrowserEdition(props.recorder);
  const addLibrary = async () => {
    if (!library) return;
    const path = await library.pickFolder(t("settings.libraries.pickTitle"));
    if (!path) return;
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? t("settings.libraries.defaultName");
    await run(() => library.addLibrary(name, path));
  };
  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.libraries")}</h2>
      <p className="mb-4 text-sm leading-relaxed text-secondary">{t("settings.libraries.intro")}</p>
      {browser && (
        <p className="mb-4 text-sm leading-relaxed text-secondary">
          {t("settings.libraries.browserIntro")}
        </p>
      )}
      <ul className="card flex flex-col">
        {props.libraries.map((item, index) => (
          <li
            key={item.id}
            className={`flex items-center gap-3.5 px-4 py-3.5 ${index > 0 ? "border-t border-subtle" : ""}`}
          >
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-[10px] ${item.isDefault ? "bg-selected text-blue" : "bg-subtle text-secondary"}`}
            >
              <Icon name={item.managed ? "people" : "folder"} size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <strong className="text-sm text-navy">{item.name}</strong>
                {item.isDefault && (
                  <span className="chip bg-selected font-semibold text-link">
                    {t("settings.libraries.default")}
                  </span>
                )}
              </div>
              <span className="truncate text-[13px] text-secondary" title={item.path}>
                {item.builtIn ? t("settings.libraries.inBrowser") : item.path}
                {item.needsAccess
                  ? ` · ${t("settings.libraries.needsAccess")}`
                  : ` · ${t("library.count", { count: item.guideCount })}`}
              </span>
            </div>
            {library?.openFolder && !item.builtIn && !item.needsAccess && (
              <button
                type="button"
                className="btn h-8 px-3"
                onClick={() =>
                  void library.openFolder?.(item.id).catch((error: unknown) =>
                    props.notify({
                      kind: "error",
                      text: errorMessage(error, t("settings.libraries.openFailed")),
                    }),
                  )
                }
              >
                <Icon name="folder" size={15} />
                {t("settings.libraries.openFolder")}
              </button>
            )}
            {item.managed ? (
              <span className="flex items-center gap-1.5 text-xs text-secondary">
                <Icon name="lock" size={14} />
                {t("settings.managed")}
              </span>
            ) : (
              <>
                {item.needsAccess && library?.allowAccess && (
                  <button
                    type="button"
                    className="btn h-8 px-3"
                    onClick={() =>
                      void run(() => library.allowAccess?.(item.id) ?? Promise.resolve())
                    }
                  >
                    {t("settings.libraries.allow")}
                  </button>
                )}
                {!item.isDefault && policy().defaultLibrary === null && (
                  <button
                    type="button"
                    className="btn h-8 px-3"
                    disabled={props.locked}
                    onClick={() => library && void run(() => library.setDefaultLibrary(item.id))}
                  >
                    {t("settings.libraries.makeDefault")}
                  </button>
                )}
                {!item.isDefault && !item.builtIn && (
                  <button
                    type="button"
                    className="icon-btn size-8"
                    aria-label={t("settings.libraries.remove", { name: item.name })}
                    title={t("settings.libraries.removeHelp")}
                    onClick={() => library && void run(() => library.removeLibrary(item.id))}
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3.5 flex gap-2.5">
        <button
          type="button"
          className="btn text-link"
          disabled={!library}
          onClick={() => void addLibrary()}
        >
          <Icon name="plus" size={15} />
          {t("settings.libraries.add")}
        </button>
      </div>
      <p className="mt-3.5 text-[13px] leading-relaxed text-secondary">
        {t("settings.libraries.note")}
      </p>
    </>
  );
}
