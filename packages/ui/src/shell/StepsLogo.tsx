import { useTranslation } from "react-i18next";

import amlutoWhite from "../assets/logo-horizontal-white.svg";
import mark from "../assets/steps-mark.svg";

/** The Steps mark and name with "by Amluto" beneath it, on the navy sidebar and welcome panel. */
export function StepsLogo({ size = "small" }: { size?: "small" | "large" }) {
  const { t } = useTranslation();
  const large = size === "large";
  return (
    <span className="flex items-center gap-2.5 self-start">
      <img src={mark} alt="" className={large ? "size-[38px]" : "size-[30px]"} />
      <span className="flex flex-col leading-none">
        <span
          className={`font-heading font-semibold tracking-tight text-white ${large ? "text-[26px]" : "text-[21px]"}`}
        >
          {t("app.name")}
        </span>
        <span
          className={`mt-1.5 flex items-center gap-1.5 text-white/75 ${large ? "text-[14px]" : "text-[12px]"}`}
        >
          {t("app.by")}
          <img
            src={amlutoWhite}
            alt={t("app.logoAlt")}
            className={large ? "h-4 w-auto" : "h-3.5 w-auto"}
          />
        </span>
      </span>
    </span>
  );
}
