import { describe, expect, it } from "vitest";

import {
  clearPicked,
  currentIn,
  pick,
  pickAll,
  pickedIn,
  pickOne,
  show,
  startPicking,
} from "./picking";

/** The library's guides, in the order shown. */
const guides = ["g1", "g2", "g3", "g4", "g5"];

describe("picking guides, with nothing on screen", () => {
  it("adds a guide with Ctrl-click, and takes it away again", () => {
    const one = pick(startPicking(), guides, "g2", "toggle");
    expect(pickedIn(one, guides)).toEqual(["g2"]);
    expect(pickedIn(pick(one, guides, "g2", "toggle"), guides)).toEqual([]);
  });

  it("ranges from the last guide ticked or unticked", () => {
    const two = pick(pick(startPicking(), guides, "g1", "toggle"), guides, "g3", "toggle");
    const unticked = pick(two, guides, "g1", "toggle");
    expect(pickedIn(pick(unticked, guides, "g2", "addRange"), guides)).toEqual(["g1", "g2", "g3"]);
  });

  it("adds everything from the last one clicked with Shift-click, either way", () => {
    const start = pick(pick(startPicking(), guides, "g1", "toggle"), guides, "g4", "toggle");
    const down = pick(start, guides, "g2", "addRange");
    expect(pickedIn(down, guides)).toEqual(["g1", "g2", "g3", "g4"]);
    // The anchor stays where it was: another Shift-click ranges from it again.
    expect(pickedIn(pick(down, guides, "g5", "addRange"), guides)).toEqual(guides);
  });

  it("takes a Shift-click with nowhere to start from as a Ctrl-click, which anchors there", () => {
    const first = pick(startPicking(), guides, "g2", "addRange");
    expect(pickedIn(first, guides)).toEqual(["g2"]);
    expect(pickedIn(pick(first, guides, "g4", "addRange"), guides)).toEqual(["g2", "g3", "g4"]);
    // The last one clicked is hidden by a search: the guide is ticked or unticked on its own.
    const shown = ["g1", "g3", "g5"];
    expect(pickedIn(pick(first, shown, "g3", "addRange"), guides)).toEqual(["g2", "g3"]);
    const both = pick(pick(first, guides, "g3", "toggle"), guides, "g5", "toggle");
    expect(pickedIn(pick(both, ["g1", "g2", "g3"], "g3", "addRange"), guides)).toEqual([
      "g2",
      "g5",
    ]);
  });

  it("keeps guides a search hides picked, until Select all picks only those shown", () => {
    const hidden = pick(startPicking(), guides, "g5", "toggle");
    const shown = ["g1", "g2", "g3"];
    const more = pick(pick(hidden, shown, "g1", "toggle"), shown, "g3", "addRange");
    expect(pickedIn(more, guides)).toEqual(["g1", "g2", "g3", "g5"]);
    expect(pickedIn(pickAll(more, shown), guides)).toEqual(shown);
  });

  it("starts afresh once cleared: nothing picked, and a Shift-click ranges from nowhere", () => {
    const cleared = clearPicked(pick(startPicking(), guides, "g1", "toggle"));
    expect(pickedIn(cleared, guides)).toEqual([]);
    expect(pickedIn(pick(cleared, guides, "g3", "addRange"), guides)).toEqual(["g3"]);
  });

  it("gives the picked in the list's order, whatever order they were picked in", () => {
    const picked = ["g4", "g1", "g3"].reduce(
      (now, id) => pick(now, guides, id, "toggle"),
      startPicking(),
    );
    expect(pickedIn(picked, guides)).toEqual(["g1", "g3", "g4"]);
    expect(pickedIn(picked, ["g3", "g2", "g1"])).toEqual(["g3", "g1"]);
  });

  it("never has one on screen: a guide picked alone or shown is no place to range from", () => {
    const one = pickOne(startPicking(), "g2");
    expect(pickedIn(one, guides)).toEqual(["g2"]);
    const shown = show(clearPicked(one), "g4");
    expect(currentIn(shown, guides)).toBeNull();
    expect(pickedIn(pick(shown, guides, "g2", "addRange"), guides)).toEqual(["g2"]);
  });
});

/** The editor's steps, in the guide's order. */
const steps = ["s1", "s2", "s3", "s4", "s5"];

describe("picking steps, with one on screen", () => {
  it("counts the step on screen as picked: Ctrl-click adds another and shows it", () => {
    const start = startPicking({ current: "s1" });
    // One step on its own is just the step on screen, not a group.
    expect(pickedIn(start, steps)).toEqual([]);
    expect(currentIn(start, steps)).toBe("s1");
    const two = pick(start, steps, "s3", "toggle");
    expect(pickedIn(two, steps)).toEqual(["s1", "s3"]);
    expect(currentIn(two, steps)).toBe("s3");
  });

  it("shows the last one picked of those left when the step on screen is unpicked", () => {
    const four = ["s3", "s1", "s5"].reduce(
      (now, id) => pick(now, steps, id, "toggle"),
      startPicking({ current: "s2" }),
    );
    const left = pick(four, steps, "s5", "toggle");
    expect(pickedIn(left, steps)).toEqual(["s1", "s2", "s3"]);
    expect(currentIn(left, steps)).toBe("s1");
    // Unpicking another leaves the step on screen where it is.
    const fewer = pick(left, steps, "s2", "toggle");
    expect(pickedIn(fewer, steps)).toEqual(["s1", "s3"]);
    expect(currentIn(fewer, steps)).toBe("s1");
    // A range picked upwards shows its top step, which stays on screen when another is unpicked.
    const upwards = pick(startPicking({ current: "s4" }), steps, "s2", "range");
    expect(currentIn(pick(upwards, steps, "s3", "toggle"), steps)).toBe("s2");
  });

  it("keeps the step on screen when it's Ctrl-clicked on its own", () => {
    const alone = pick(startPicking({ current: "s2" }), steps, "s2", "toggle");
    expect(currentIn(alone, steps)).toBe("s2");
    expect(pickedIn(alone, steps)).toEqual([]);
  });

  it("picks from the anchor with Shift-click, in place of what was picked, and shows the step", () => {
    const two = pick(
      pick(startPicking({ current: "s1" }), steps, "s5", "toggle"),
      steps,
      "s2",
      "toggle",
    );
    const range = pick(two, steps, "s4", "range");
    expect(pickedIn(range, steps)).toEqual(["s2", "s3", "s4"]);
    expect(currentIn(range, steps)).toBe("s4");
  });

  it("adds the range to what's picked with Ctrl+Shift-click", () => {
    const two = pick(startPicking({ current: "s1" }), steps, "s4", "toggle");
    const more = pick(two, steps, "s5", "addRange");
    expect(pickedIn(more, steps)).toEqual(["s1", "s4", "s5"]);
    expect(currentIn(more, steps)).toBe("s5");
  });

  it("starts a range at the step on screen while there's no anchor, and anchors it there", () => {
    const range = pick(startPicking({ current: "s2" }), steps, "s4", "range");
    expect(pickedIn(range, steps)).toEqual(["s2", "s3", "s4"]);
    const further = pick(range, steps, "s5", "range");
    expect(pickedIn(further, steps)).toEqual(["s2", "s3", "s4", "s5"]);
    // Escape lets the anchor go too: the next range starts at the step on screen.
    expect(pickedIn(pick(clearPicked(further), steps, "s3", "range"), steps)).toEqual([
      "s3",
      "s4",
      "s5",
    ]);
  });

  it("starts a range at the step on screen once the anchor has gone", () => {
    const range = pick(startPicking({ current: "s1" }), steps, "s3", "range");
    const withoutFirst = ["s2", "s3", "s4", "s5"];
    expect(pickedIn(pick(range, withoutFirst, "s5", "range"), steps)).toEqual(["s3", "s4", "s5"]);
  });

  it("shows the first step once the step on screen has gone, and none once every step has", () => {
    const third = startPicking({ current: "s3" });
    expect(currentIn(third, ["s1", "s2"])).toBe("s1");
    expect(currentIn(third, [])).toBeNull();
  });

  it("lets steps that have gone drop out, and one left on its own is no group", () => {
    const two = pick(startPicking({ current: "s1" }), steps, "s3", "toggle");
    const withoutFirst = ["s2", "s3", "s4", "s5"];
    expect(pickedIn(two, withoutFirst)).toEqual([]);
    // The next Ctrl-click adds to the step on screen alone, even if the first comes back.
    expect(pickedIn(pick(two, withoutFirst, "s5", "toggle"), steps)).toEqual(["s3", "s5"]);
    // So too when the one left isn't the step on screen.
    const elsewhere = show(pick(startPicking({ current: "s1" }), steps, "s2", "toggle"), "s4");
    const withoutSecond = ["s1", "s3", "s4", "s5"];
    expect(pickedIn(pick(elsewhere, withoutSecond, "s5", "toggle"), steps)).toEqual(["s4", "s5"]);
  });

  it("shows one step alone with a plain click, and anchors a Shift range there", () => {
    const one = pickOne(pickAll(startPicking({ current: "s1" }), steps), "s4");
    expect(pickedIn(one, steps)).toEqual([]);
    expect(currentIn(one, steps)).toBe("s4");
    expect(pickedIn(pick(one, steps, "s2", "range"), steps)).toEqual(["s2", "s3", "s4"]);
    expect(pickedIn(pick(show(one, "s5"), steps, "s2", "range"), steps)).toEqual([
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("lets every step go when the guide's details are chosen, and has none on screen", () => {
    const details = pickOne(pickAll(startPicking({ current: "s1" }), steps), null);
    expect(pickedIn(details, steps)).toEqual([]);
    expect(currentIn(details, steps)).toBeNull();
    // A Shift-click from there has nowhere to start: it shows that step on its own.
    const shift = pick(details, steps, "s3", "range");
    expect(pickedIn(shift, steps)).toEqual([]);
    expect(currentIn(shift, steps)).toBe("s3");
  });

  it("keeps the picked and the anchor when a step is shown without picking", () => {
    // Previous and Next, a comment's step, the export review's.
    const two = pick(startPicking({ current: "s1" }), steps, "s2", "toggle");
    const next = show(two, "s3");
    expect(pickedIn(next, steps)).toEqual(["s1", "s2"]);
    expect(currentIn(next, steps)).toBe("s3");
    expect(pickedIn(pick(next, steps, "s4", "range"), steps)).toEqual(["s2", "s3", "s4"]);
  });
});
