/* Sample data for P0. The server replaces this in P2 (calendar) and P3 (articles). */
var NS_SAMPLE = {
  weather: { now: "48° and clear", sub: "Low 41° · sunrise 6:34", sunrise: "6:34", low: "41°" },
  tomorrow: {
    label: "Sun, Nov 8",
    // kind comes from the server's AI filter: meeting | block | hold | skip
    events: [
      { start: "08:00", title: "Focus block", kind: "block", len: "" },
      { start: "09:30", title: "Team standup", kind: "meeting", len: "30 min", where: "Zoom" },
      { start: "10:00", title: "Hold — maybe coffee", kind: "hold", len: "" },
      { start: "11:00", title: "Investor call", kind: "meeting", len: "45 min" },
      { start: "12:30", title: "Lunch", kind: "block", len: "" },
      { start: "14:00", title: "Design review", kind: "meeting", len: "1 h" }
    ]
  },
  alarmRule: { leadMinutes: 75, earliest: "07:00", latest: "09:00", fallback: "08:30" },
  room: "Bedroom",
  speaker: "Bedroom",
  lamps: [
    { id: 9, name: "Desk lamp", on: true, pct: 40 },
    { id: 10, name: "Bed lamp", on: true, pct: 20 }
  ],
  shelf: [
    { kind: "Book", title: "Spidercat", by: "On this Kindle", style: "black", pct: 64, note: "64% · 2 h left" },
    { kind: "Article", title: "The Quiet Hours", by: "Long read", style: "", pct: 30, note: "18 min left" },
    { kind: "Book", title: "A Field Guide to Sleep", by: "Sample book", style: "gray", pct: 12, note: "12% · 6 h left" },
    { kind: "Article", title: "Notes on Slowness", by: "Long read", style: "", pct: 0, note: "New · 24 min" }
  ],
  newCount: 3
};

/* Desktop preview only: a sample library, so the UI runs against real-looking
   items before it reaches the Kindle. Never used on the device. */
var NS_SAMPLE_AMAZON = "B0FR9FGYVT\tLife at the Speed of Play\t[{\"name\":{\"display\":\"Pincus, Mark\"}}]\t20.68\t1794101147\nB073TS2ZWN\tHow to Build a Car: The Autobiography of the World\u2019s Greatest Formula 1 Designer\t[{\"name\":{\"display\":\"Newey, Adrian\"}}]\t89.3\t1777000000";
var NS_SAMPLE_LIBRARY = { items: [
  { id: "s1", kind: "article", title: "The shape of the shadow of The Thing", author: "Ethan Mollick", site: "oneusefulthing.org", minutes: 10, ready_at: 1794098300000 },
  { id: "s2", kind: "article", title: "Building Python tools with a one-shot prompt using uv run and Claude Projects", site: "simonwillison.net", minutes: 3, ready_at: 1794098200000 },
  { id: "s3", kind: "article", title: "Building effective agents", site: "Anthropic", minutes: 11, ready_at: 1794098100000 },
  { id: "s4", kind: "article", title: "How to Do Great Work", site: "paulgraham.com", minutes: 51, ready_at: 1794090000000 },
  { id: "s5", kind: "article", title: "A very long title that keeps going to test how the row wraps on two lines and then gets clipped", site: "example.com", minutes: 24, ready_at: 1794080000000 },
  { id: "s6", kind: "article", title: "Notes on Slowness", site: "Long read", minutes: 24, ready_at: 1794070000000 },
  { id: "s7", kind: "article", title: "The Quiet Hours", site: "Long read", minutes: 18, ready_at: 1794060000000 },
  { id: "s8", kind: "article", title: "Why Fund I Is the Real Test", site: "Newsletter", minutes: 11, ready_at: 1794050000000 }
],
  sampleBooks: { book: { title: "Middlemarch", author: "George Eliot", year: 1871 }, shelfmark: true, options: [
    { source: "gutenberg", ref: "145", title: "Middlemarch", author: "George Eliot" },
    { source: "gutenberg", ref: "8227", title: "Middlemarch", author: "George Eliot" } ] }
};
