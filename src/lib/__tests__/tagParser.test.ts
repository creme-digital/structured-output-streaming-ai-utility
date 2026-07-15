import { describe, expect, it } from "vitest";
import {
  ADD_TAG_DEFINITION,
  AddTagAttrs,
  createDefaultTagRegistry,
  extractTags,
  RecommendTagAttrs,
  stripTrailingPartialTag,
  TagRegistry,
} from "../tagParser";

describe("extractTags — <ADD> position independence (FR-003 AC1)", () => {
  const registry = createDefaultTagRegistry();

  it("extracts a tag at the end of the response", () => {
    const text = 'Great pick! <ADD item="Inception" rating="5" />';
    const { matches, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(1);
    // Cycle 6 / FR-003: a plain <ADD> with no status attribute now parses to an
    // explicit status: "watched" (the default), alongside the pre-existing item/rating.
    expect(matches[0].attrs).toEqual({ item: "Inception", rating: 5, status: "watched" });
    expect(cleanedText).toBe("Great pick! ");
  });

  it("extracts a tag at the start of the response", () => {
    const text = '<ADD item="Inception" rating="5" /> Great pick!';
    const { matches, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(1);
    expect(cleanedText).toBe(" Great pick!");
  });

  it("extracts a tag interleaved in the middle of prose", () => {
    const text = 'Noted — <ADD item="Inception" rating="5" /> that sounds like a favorite.';
    const { matches, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(1);
    expect(matches[0].attrs.item).toBe("Inception");
    expect(cleanedText).toBe("Noted —  that sounds like a favorite.");
  });

  it("extracts multiple tags in one response", () => {
    const text = '<ADD item="Inception" rating="5" /> and also <ADD item="Tenet" rating="4" />';
    const { matches } = extractTags(text, registry);
    expect(matches.map((m) => m.attrs.item)).toEqual(["Inception", "Tenet"]);
  });

  it("leaves prose with no tag untouched", () => {
    const text = "Sounds like you had a mixed reaction to that one.";
    const { matches, malformed, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });

  it("ignores unknown/unregistered tag names entirely", () => {
    // REMOVE remains deliberately unregistered/deferred (see out_of_scope) — <UPDATE>
    // moved from "unregistered example" to "actually shipped" in Cycle 4 (FR-009), see
    // the dedicated <UPDATE> describe block below.
    const text = 'Here is one: <REMOVE item="Inception" /> done.';
    const { matches, malformed, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });
});

describe("extractTags — <UPDATE> as a third registered tag type (Cycle 4 / FR-003 AC + FR-009)", () => {
  const registry = createDefaultTagRegistry();

  it("extracts a well-formed <UPDATE> tag alongside prose", () => {
    const text = 'Got it, updating that one. <UPDATE item="Inception" rating="4" />';
    const { matches, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(1);
    expect(matches[0].tag).toBe("UPDATE");
    expect(matches[0].attrs).toEqual({ item: "Inception", rating: 4 });
    expect(cleanedText).toBe("Got it, updating that one. ");
  });

  it("extracts <ADD> and <UPDATE> as distinct tag types from the same response", () => {
    const text = '<ADD item="Tenet" rating="4" /> and <UPDATE item="Inception" rating="3" />';
    const { matches } = extractTags(text, registry);
    expect(matches.map((m) => m.tag)).toEqual(["ADD", "UPDATE"]);
  });

  it("flags a malformed <UPDATE> (out-of-range rating) the same way as a malformed <ADD>", () => {
    const text = '<UPDATE item="Inception" rating="9" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].tag).toBe("UPDATE");
  });
});

describe("extractTags — <ADD status=\"want_to_watch\"> (Cycle 6 / FR-001, FR-003)", () => {
  const registry = createDefaultTagRegistry();

  it("extracts a want-to-watch <ADD> with the rating attribute omitted, without treating it as malformed", () => {
    const text = '<ADD item="Dune" status="want_to_watch" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(malformed).toHaveLength(0);
    expect(matches).toHaveLength(1);
    expect(matches[0].attrs).toEqual({ item: "Dune", rating: null, status: "want_to_watch" });
  });

  it("still requires rating for a normal <ADD> with no status attribute", () => {
    const text = '<ADD item="Dune" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].reason).toMatch(/rating/);
  });

  it("still requires rating for an <ADD> explicitly marked status=\"watched\"", () => {
    const text = '<ADD item="Dune" status="watched" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });

  it("flags an unrecognized status value as malformed", () => {
    const text = '<ADD item="Dune" status="bogus" rating="5" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });
});

describe("extractTags — <RECOMMEND> as a third registered tag type (FR-003 AC + FR-008)", () => {
  const registry = createDefaultTagRegistry();

  it("extracts a well-formed <RECOMMEND> tag, display-only (no rating/item-write shape)", () => {
    const text = 'You might like this one. <RECOMMEND item="Arrival" reason="You loved Inception\'s puzzle-box plotting." />';
    const { matches, cleanedText } = extractTags(text, registry);
    expect(matches).toHaveLength(1);
    expect(matches[0].tag).toBe("RECOMMEND");
    const attrs = matches[0].attrs as unknown as RecommendTagAttrs;
    expect(attrs.item).toBe("Arrival");
    expect(attrs.reason).toMatch(/Inception/);
    expect(cleanedText).toBe("You might like this one. ");
  });

  it("flags a <RECOMMEND> missing its reason attribute as malformed", () => {
    const text = '<RECOMMEND item="Arrival" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].tag).toBe("RECOMMEND");
  });

  it("extracts <ADD> and <RECOMMEND> as distinct tag types from the same response", () => {
    const text = '<ADD item="Tenet" rating="4" /> <RECOMMEND item="Arrival" reason="Similar vibe." />';
    const { matches } = extractTags(text, registry);
    expect(matches.map((m) => m.tag)).toEqual(["ADD", "RECOMMEND"]);
  });
});

describe("extractTags — malformed handling (FR-004)", () => {
  const registry = createDefaultTagRegistry();

  it("flags a tag missing the rating attribute as malformed", () => {
    const text = '<ADD item="Inception" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].reason).toMatch(/rating/);
  });

  it("flags a non-numeric rating as malformed", () => {
    const text = '<ADD item="Inception" rating="high" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });

  it("flags an out-of-range rating as malformed", () => {
    const text = '<ADD item="Inception" rating="11" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });

  it("flags an empty item as malformed", () => {
    const text = '<ADD item="" rating="5" />';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });

  it("flags a non-self-closing recognized tag as malformed", () => {
    const text = '<ADD item="Inception" rating="5">';
    const { matches, malformed } = extractTags(text, registry);
    expect(matches).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].reason).toMatch(/self-closing/);
  });
});

describe("stripTrailingPartialTag — hides in-flight tag markup while streaming", () => {
  it("removes an unterminated trailing tag start", () => {
    expect(stripTrailingPartialTag('Great pick! <ADD item="Ince')).toBe("Great pick! ");
  });

  it("leaves complete text with no trailing '<' untouched", () => {
    expect(stripTrailingPartialTag("Great pick!")).toBe("Great pick!");
  });

  it("handles text ending exactly at a bare '<'", () => {
    expect(stripTrailingPartialTag("Great pick! <")).toBe("Great pick! ");
  });
});

describe("TagRegistry — extensibility (FR-003 AC3)", () => {
  it("supports registering additional tag types without touching the extraction engine", () => {
    interface UpdateAttrs {
      item: string;
    }
    const registry = new TagRegistry().register(ADD_TAG_DEFINITION).register<UpdateAttrs>({
      name: "UPDATE",
      requiredAttrs: ["item"],
      validate: (attrs) => (attrs.item ? { item: attrs.item } : null),
    });

    const text = '<ADD item="Inception" rating="5" /> and <UPDATE item="Tenet" />';
    const { matches } = extractTags(text, registry);
    expect(matches).toHaveLength(2);
    expect(matches[0].tag).toBe("ADD");
    expect(matches[1].tag).toBe("UPDATE");
  });
});

describe("simulated incremental streaming", () => {
  it("only surfaces the completed tag once the full stream has arrived", () => {
    const registry = createDefaultTagRegistry();
    const fullResponse = 'Got it. <ADD item="Inception" rating="5" /> Logged!';
    let buffer = "";
    const chunks = fullResponse.match(/.{1,7}/g) ?? [];

    for (const chunk of chunks) {
      buffer += chunk;
      const display = stripTrailingPartialTag(extractTags(buffer, registry).cleanedText);
      // Never leak raw tag markup into what would be shown to the user mid-stream.
      expect(display).not.toContain("<ADD");
      expect(display).not.toContain("/>");
    }

    const finalResult = extractTags(buffer, registry);
    expect(finalResult.matches).toHaveLength(1);
    const attrs = finalResult.matches[0].attrs as unknown as AddTagAttrs;
    expect(attrs.item).toBe("Inception");
    expect(attrs.rating).toBe(5);
  });
});
