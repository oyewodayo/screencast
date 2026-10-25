// utils/stickerIcons.ts
//
// The icons stickers carry and the Elements gallery offers on their own - line icons on a 24-unit
// grid, stroked round at 2.2 units (a few drawn filled), plus the Briefcast mark. One table says
// each icon's name, the words it's found by and its group, so the gallery and the sticker panel
// search and list the same set.

export type IconGroup = "Basics" | "People" | "Talk" | "Media" | "Work" | "Places" | "Things" | "Signs";

interface IconDef {
  value: string;
  label: string;
  group: IconGroup;
  keywords?: string;
  paths: readonly string[];
  // Filled rather than stroked.
  solid?: boolean;
}

const circle = (cx: number, cy: number, r: number) => `M${cx} ${cy - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`;

const ICON_DEFS = [
  // basics
  { value: "check", label: "Check", group: "Basics", keywords: "done tick yes ok", paths: ["M20 6L9 17l-5-5"] },
  { value: "x", label: "Cross", group: "Basics", keywords: "no close wrong cancel", paths: ["M18 6L6 18", "M6 6l12 12"] },
  { value: "plus", label: "Plus", group: "Basics", keywords: "add more new", paths: ["M12 5v14", "M5 12h14"] },
  { value: "minus", label: "Minus", group: "Basics", keywords: "less remove", paths: ["M5 12h14"] },
  { value: "arrow-right", label: "Arrow right", group: "Basics", keywords: "next go forward", paths: ["M4 12h16", "M13.5 5.5L20 12l-6.5 6.5"] },
  { value: "arrow-left", label: "Arrow left", group: "Basics", keywords: "back previous", paths: ["M20 12H4", "M10.5 5.5L4 12l6.5 6.5"] },
  { value: "arrow-up", label: "Arrow up", group: "Basics", keywords: "up rise increase", paths: ["M12 20V4", "M5.5 10.5L12 4l6.5 6.5"] },
  { value: "arrow-down", label: "Arrow down", group: "Basics", keywords: "down step next", paths: ["M12 4v16", "M18.5 13.5L12 20l-6.5-6.5"] },
  { value: "star", label: "Star", group: "Basics", keywords: "favourite rating best", solid: true, paths: ["M12 2.5l2.9 6l6.6.9l-4.8 4.6l1.2 6.5L12 17.4l-5.9 3.1l1.2-6.5l-4.8-4.6l6.6-.9Z"] },
  { value: "heart", label: "Heart", group: "Basics", keywords: "love like", solid: true, paths: ["M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2c-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"] },
  { value: "sparkle", label: "Sparkle", group: "Basics", keywords: "magic new shine ai", solid: true, paths: ["M12 2.5l2.2 6.3a1.5 1.5 0 0 0 1 1l6.3 2.2l-6.3 2.2a1.5 1.5 0 0 0-1 1L12 21.5l-2.2-6.3a1.5 1.5 0 0 0-1-1L2.5 12l6.3-2.2a1.5 1.5 0 0 0 1-1Z"] },
  { value: "bolt", label: "Bolt", group: "Basics", keywords: "fast power energy lightning", solid: true, paths: ["M13 2L4 13.5h7.5L11 22l9-11.5h-7.5Z"] },
  { value: "fire", label: "Fire", group: "Basics", keywords: "hot trending lit", solid: true, paths: ["M12 2c1 4 6 6.5 6 12a6 6 0 0 1-12 0c0-3 1.6-5.2 3-6.2c0 2 .9 3.2 2.2 3.4C11.2 7.8 10.4 5 12 2Z"] },
  { value: "crown", label: "Crown", group: "Basics", keywords: "king queen winner premium", solid: true, paths: ["M2.5 7.5l5 4.5L12 5l4.5 7l5-4.5L19.5 19h-15Z"] },
  { value: "info", label: "Info", group: "Basics", keywords: "about help note", paths: [circle(12, 12, 10), "M12 16.5v-5", "M12 7.6h.01"] },
  { value: "alert", label: "Warning", group: "Basics", keywords: "alert attention caution", paths: ["M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z", "M12 9v4", "M12 17h.01"] },
  { value: "question", label: "Question", group: "Basics", keywords: "help faq ask", paths: [circle(12, 12, 10), "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"] },
  { value: "target", label: "Target", group: "Basics", keywords: "goal aim focus", paths: [circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2)] },
  // people
  { value: "user", label: "Person", group: "People", keywords: "profile account me", paths: [circle(12, 7.5, 4), "M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"] },
  { value: "users", label: "People", group: "People", keywords: "team group community trained", paths: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9, 7, 4), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"] },
  { value: "smile", label: "Smile", group: "People", keywords: "happy face emoji", paths: [circle(12, 12, 10), "M8 14s1.5 2 4 2s4-2 4-2", "M9 9.5h.01", "M15 9.5h.01"] },
  { value: "thumbs-up", label: "Thumbs up", group: "People", keywords: "like good approve", paths: ["M7 10v11", "M15 5.9L14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"] },
  { value: "hand", label: "Wave", group: "People", keywords: "hello hi hand stop", paths: ["M18 11V6a2 2 0 0 0-4 0v5", "M14 10V4a2 2 0 0 0-4 0v6", "M10 10.5V6a2 2 0 0 0-4 0v8", "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"] },
  { value: "cap", label: "Graduate", group: "People", keywords: "school education degree learn", paths: ["M22 9.5L12 4.5L2 9.5l10 5l10-5Z", "M6 11.5v4.8c3.2 2.6 8.8 2.6 12 0v-4.8", "M22 9.5v5.5"] },
  { value: "trophy", label: "Trophy", group: "People", keywords: "win award prize first", paths: ["M6 9H4.5a2.5 2.5 0 0 1 0-5H6", "M18 9h1.5a2.5 2.5 0 0 0 0-5H18", "M6 3h12v6a6 6 0 0 1-12 0Z", "M12 15v4", "M8 21h8"] },
  { value: "shield", label: "Verified", group: "People", keywords: "secure safe trust check", paths: ["M12 22s8-4 8-10V5l-8-3l-8 3v7c0 6 8 10 8 10Z", "M9 12l2 2l4-4"] },
  // talk
  { value: "chat", label: "Chat", group: "Talk", keywords: "message comment talk bubble", paths: ["M21 11.5a8.4 8.4 0 0 1-9 8.4a8.9 8.9 0 0 1-3.8-.9L3 20.5l1.5-4.3A8.4 8.4 0 1 1 21 11.5Z"] },
  { value: "mail", label: "Mail", group: "Talk", keywords: "email newsletter inbox contact", paths: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M22 7l-10 6L2 7"] },
  { value: "phone", label: "Phone", group: "Talk", keywords: "mobile app call contact", paths: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M11 18h2"] },
  { value: "send", label: "Send", group: "Talk", keywords: "share paper plane dm", paths: ["M22 2L11 13", "M22 2l-7 20l-4-9l-9-4Z"] },
  { value: "share", label: "Share", group: "Talk", keywords: "network social connect", paths: [circle(18, 5.5, 3), circle(6, 12, 3), circle(18, 18.5, 3), "M8.6 13.5l6.8 4", "M15.4 6.5l-6.8 4"] },
  { value: "bell", label: "Bell", group: "Talk", keywords: "notification alert subscribe", paths: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.9 1.9 0 0 0 3.4 0"] },
  { value: "megaphone", label: "Announce", group: "Talk", keywords: "megaphone news launch shout", paths: ["M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"] },
  { value: "quote", label: "Quote", group: "Talk", keywords: "testimonial review said", solid: true, paths: ["M3 21c3 0 7-1 7-8V5H3v7h4c0 4-2 6-4 6Z", "M14 21c3 0 7-1 7-8V5h-7v7h4c0 4-2 6-4 6Z"] },
  // media
  { value: "play", label: "Play", group: "Media", keywords: "video watch start", solid: true, paths: ["M7 4.5v15l12-7.5Z"] },
  { value: "video", label: "Video", group: "Media", keywords: "camera film record", paths: ["M3 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z", "M16 10.5l6-3.5v10l-6-3.5"] },
  { value: "camera", label: "Camera", group: "Media", keywords: "photo picture shoot", paths: ["M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z", circle(12, 13, 3.5)] },
  { value: "mic", label: "Microphone", group: "Media", keywords: "podcast audio voice speak", paths: ["M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z", "M19 10v1a7 7 0 0 1-14 0v-1", "M12 18v4", "M8 22h8"] },
  { value: "music", label: "Music", group: "Media", keywords: "song audio note", paths: ["M9 18V5l12-2v13", circle(6, 18, 3), circle(18, 16, 3)] },
  { value: "eye", label: "Eye", group: "Media", keywords: "view see watch look", paths: ["M2 12s3.5-7 10-7s10 7 10 7s-3.5 7-10 7S2 12 2 12Z", circle(12, 12, 3)] },
  { value: "image", label: "Picture", group: "Media", keywords: "photo gallery", paths: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", circle(9, 9, 2), "M21 15l-5-5L5 21"] },
  { value: "briefcast", label: "Briefcast", group: "Media", keywords: "logo made with brand cast screen", paths: [] },
  // work
  { value: "doc", label: "Document", group: "Work", keywords: "file transcript paper page", paths: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8"] },
  { value: "briefcase", label: "Briefcase", group: "Work", keywords: "job work business career", paths: ["M4 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z", "M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"] },
  { value: "book", label: "Book", group: "Work", keywords: "read learn course guide", paths: ["M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"] },
  { value: "calendar", label: "Date", group: "Work", keywords: "event schedule day", paths: ["M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M16 2v4", "M8 2v4", "M3 10h18"] },
  { value: "clock", label: "Clock", group: "Work", keywords: "time hours duration", paths: [circle(12, 12, 10), "M12 6v6l4 2"] },
  { value: "trend", label: "Growth", group: "Work", keywords: "chart up increase stats", paths: ["M22 7l-8.5 8.5l-5-5L2 17", "M16 7h6v6"] },
  { value: "chart", label: "Chart", group: "Work", keywords: "bars stats data analytics", paths: ["M3 21h18", "M6 17v-6", "M12 17V5", "M18 17V9"] },
  { value: "bulb", label: "Idea", group: "Work", keywords: "tip light bulb think", paths: ["M9 18h6", "M10 22h4", "M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2Z"] },
  { value: "rocket", label: "Rocket", group: "Work", keywords: "launch startup fast growth", paths: ["M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z", "M12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z", "M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0", "M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"] },
  { value: "code", label: "Code", group: "Work", keywords: "developer programming tech", paths: ["M16 18l6-6l-6-6", "M8 6l-6 6l6 6"] },
  { value: "link", label: "Link", group: "Work", keywords: "url website chain", paths: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"] },
  { value: "download", label: "Download", group: "Work", keywords: "save get install", paths: ["M12 3v12", "M7 10l5 5l5-5", "M5 21h14"] },
  { value: "search", label: "Search", group: "Work", keywords: "find look magnify", paths: [circle(11, 11, 8), "M21 21l-4.3-4.3"] },
  { value: "lock", label: "Lock", group: "Work", keywords: "secure private password", paths: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z", "M7 11V7a5 5 0 0 1 10 0v4"] },
  // places
  { value: "pin", label: "Place", group: "Places", keywords: "location map city country", paths: ["M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z", circle(12, 10, 3)] },
  { value: "globe", label: "Globe", group: "Places", keywords: "world international global", paths: [circle(12, 12, 10), "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10a15.3 15.3 0 0 1-4 10a15.3 15.3 0 0 1-4-10a15.3 15.3 0 0 1 4-10Z"] },
  { value: "home", label: "Home", group: "Places", keywords: "house start", paths: ["M3 10l9-7l9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M9 22V12h6v10"] },
  { value: "flag", label: "Flag", group: "Places", keywords: "goal finish milestone", paths: ["M4 22V4", "M4 4c4-2 8 2 12 0s4-1 4-1v11s-1 1-4 1s-8-2-12 0"] },
  { value: "plane", label: "Travel", group: "Places", keywords: "plane flight trip", paths: ["M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8L4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1l3 2l2 3l1-1v-3l3-2l3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"] },
  { value: "sun", label: "Sun", group: "Places", keywords: "day weather summer bright", paths: [circle(12, 12, 4), "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M6.3 17.7l-1.4 1.4", "M19.1 4.9l-1.4 1.4"] },
  { value: "moon", label: "Moon", group: "Places", keywords: "night dark sleep", paths: ["M12 3a6 6 0 0 0 9 9a9 9 0 1 1-9-9Z"] },
  { value: "cloud", label: "Cloud", group: "Places", keywords: "weather online upload", paths: ["M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"] },
  // things
  { value: "gift", label: "Gift", group: "Things", keywords: "present giveaway bonus", paths: ["M3 8h18v4H3Z", "M5 12v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8", "M12 8v14", "M12 8C10 4 6 4 6.5 6.5S12 8 12 8Z", "M12 8c2-4 6-4 5.5-1.5S12 8 12 8Z"] },
  { value: "cart", label: "Cart", group: "Things", keywords: "shop buy store ecommerce", paths: ["M3 3h2l2.6 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6", circle(9, 21, 1.5), circle(18, 21, 1.5)] },
  { value: "tag", label: "Price tag", group: "Things", keywords: "sale price discount offer", paths: ["M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z", circle(7.5, 7.5, 1.5)] },
  { value: "dollar", label: "Money", group: "Things", keywords: "price cost pay revenue", paths: ["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"] },
  { value: "coffee", label: "Coffee", group: "Things", keywords: "break cafe drink", paths: ["M17 8h1a4 4 0 1 1 0 8h-1", "M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z", "M6 2v2", "M10 2v2", "M14 2v2"] },
  { value: "wifi", label: "Online", group: "Things", keywords: "wifi internet live connected", paths: ["M5 12.5a10 10 0 0 1 14 0", "M8.5 16a5 5 0 0 1 7 0", "M12 19.5h.01", "M2 9a15 15 0 0 1 20 0"] },
  { value: "percent", label: "Percent", group: "Things", keywords: "discount sale off rate", paths: ["M19 5L5 19", circle(6.5, 6.5, 2.5), circle(17.5, 17.5, 2.5)] },
  // signs
  { value: "ok-circle", label: "Approved", group: "Signs", keywords: "check done success", paths: [circle(12, 12, 10), "M8 12.5l2.7 2.7L16.5 9.5"] },
  { value: "x-circle", label: "Rejected", group: "Signs", keywords: "no wrong fail", paths: [circle(12, 12, 10), "M15 9l-6 6", "M9 9l6 6"] },
  { value: "number-1", label: "One", group: "Signs", keywords: "first step 1", paths: [circle(12, 12, 10), "M10 8.5l2.5-1.5V17"] },
  { value: "number-2", label: "Two", group: "Signs", keywords: "second step 2", paths: [circle(12, 12, 10), "M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 2.2-5.6 4.2-5.6 6.8h5.8"] },
  { value: "number-3", label: "Three", group: "Signs", keywords: "third step 3", paths: [circle(12, 12, 10), "M9.3 7.4h5.2l-3 3.6a3 3 0 1 1-2.4 4.9"] },
] as const satisfies readonly IconDef[];

export type StickerIcon = "none" | (typeof ICON_DEFS)[number]["value"];

export const ICON_GROUPS: IconGroup[] = ["Basics", "People", "Talk", "Media", "Work", "Places", "Things", "Signs"];

export const STICKER_ICONS: { value: StickerIcon; label: string; group?: IconGroup; keywords?: string }[] = [
  { value: "none", label: "None" },
  ...ICON_DEFS.map((d) => ({ value: d.value, label: d.label, group: d.group, keywords: (d as IconDef).keywords })),
];

// Icons whose name, group or keywords contain every word of `query`.
export function searchIcons(query: string): typeof STICKER_ICONS {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return STICKER_ICONS;
  return STICKER_ICONS.filter((i) => {
    const hay = `${i.label} ${i.value} ${i.group ?? ""} ${i.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const byValue = new Map<string, IconDef>(ICON_DEFS.map((d) => [d.value, d as IconDef]));
const pathCache = new Map<string, Path2D>();
const path2d = (d: string): Path2D => {
  let p = pathCache.get(d);
  if (!p) pathCache.set(d, (p = new Path2D(d)));
  return p;
};

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
};

// The Briefcast mark: a screen with cast waves coming out of its lower-left corner. The bite round
// that corner is cut with an even-odd fill (inside the screen's clip), never by erasing - erasing
// would punch through whatever the mark sits on.
function briefcastMark(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  roundRect(ctx, 1.7, 3.4, 20.6, 17.2, 2.4);
  ctx.save();
  ctx.clip();
  roundRect(ctx, 1.7, 3.4, 20.6, 17.2, 2.4);
  ctx.moveTo(2.2 + 12.6, 20.6);
  ctx.arc(2.2, 20.6, 12.6, 0, Math.PI * 2);
  ctx.fill("evenodd");
  ctx.restore();
  ctx.lineCap = "round";
  ctx.lineWidth = 1.7;
  for (const r of [9.6, 5.9, 2.3]) {
    ctx.beginPath();
    ctx.arc(2.4, 19.6, r, -Math.PI / 2, 0);
    ctx.stroke();
  }
  ctx.restore();
}

// Draws `icon` centred on cx,cy, `size` across, in `color`.
export function drawStickerIcon(ctx: CanvasRenderingContext2D, icon: StickerIcon, cx: number, cy: number, size: number, color: string): void {
  if (icon === "none" || size <= 0) return;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  if (icon === "briefcast") {
    briefcastMark(ctx, color);
    ctx.restore();
    return;
  }
  const def = byValue.get(icon);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const d of def?.paths ?? []) {
    if (def?.solid) ctx.fill(path2d(d));
    else ctx.stroke(path2d(d));
  }
  ctx.restore();
}
