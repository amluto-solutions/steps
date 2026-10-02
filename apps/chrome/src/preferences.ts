/**
 * The person's name for new guides, versions and comments. The Chrome recorder (Phase 9,
 * milestone 3) keeps the preferences and sets it; until then guides are made by "Someone".
 */
let name = "";

export const displayName = () => name;
export const setDisplayName = (value: string) => {
  name = value;
};
