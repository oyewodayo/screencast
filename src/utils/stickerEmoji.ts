// utils/stickerEmoji.ts
//
// The emoji the Elements gallery and an emoji sticker's panel offer, by category, each with the
// words it's found by. Drawn by the system's colour emoji face (stickerAssets.ts, "emoji").

export interface EmojiEntry {
  char: string;
  words: string;
}

export interface EmojiCategory {
  label: string;
  items: EmojiEntry[];
}

// "char words, char words, ..." -> entries.
const list = (spec: string): EmojiEntry[] =>
  spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [char, ...words] = part.split(" ");
      return { char, words: words.join(" ") };
    });

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    label: "Popular",
    items: list(
      "🔥 fire hot lit trending, ✨ sparkles magic new, 🎉 party celebrate tada, 🚀 rocket launch fast, 💯 hundred perfect score, ✅ check done yes, ❤️ heart love red, 👏 clap applause, 🙌 raised hands praise yay, 👀 eyes look watch, 💡 idea bulb tip, ⭐ star favourite, 🏆 trophy win award, 💪 strong muscle power, 🤯 mind blown wow, 😂 laugh tears joy, 🥳 party face celebrate, 😍 heart eyes love, 🤔 thinking hmm question, 👉 point right this, 📌 pin important, ⚡ bolt fast energy, 🎯 target goal bullseye, 💥 boom explode impact"
    ),
  },
  {
    label: "Smileys",
    items: list(
      "😀 grin happy smile, 😃 smile happy open, 😄 smile eyes happy, 😁 beaming grin, 😆 laughing squint, 😅 sweat smile phew, 🤣 rofl rolling laugh, 😂 tears joy laugh, 🙂 slight smile, 😉 wink, 😊 blush smile, 😇 angel innocent, 🥰 love hearts, 😍 heart eyes, 🤩 star struck wow, 😘 kiss, 😋 yum tasty, 😛 tongue, 😜 wink tongue crazy, 🤪 zany crazy, 🤑 money mouth rich, 🤗 hug, 🤭 oops giggle, 🤫 shush quiet secret, 🤔 thinking, 🤐 zip mouth secret, 😐 neutral meh, 😑 expressionless, 😶 no mouth speechless, 😏 smirk, 😒 unamused, 🙄 eye roll, 😬 grimace awkward, 😌 relieved calm, 😔 pensive sad, 😪 sleepy, 😴 sleeping zzz, 😷 mask sick, 🤒 sick fever, 🤯 mind blown exploding, 🥳 partying celebrate, 😎 cool sunglasses, 🤓 nerd geek, 🧐 monocle inspect, 😕 confused, 😟 worried, 😮 open mouth surprised, 😲 astonished shocked, 🥺 pleading puppy eyes, 😢 crying sad tear, 😭 sobbing, 😱 scream fear, 😤 huff determined, 😡 angry pout, 🤬 cursing angry, 💀 skull dead, 🤡 clown, 👻 ghost boo, 👽 alien, 🤖 robot ai bot"
    ),
  },
  {
    label: "Gestures",
    items: list(
      "👍 thumbs up like yes good, 👎 thumbs down dislike no, 👏 clap, 🙌 raised hands, 👐 open hands, 🤝 handshake deal partner, 🙏 pray please thanks, 👋 wave hello bye, ✋ hand stop, 🤚 raised back hand, 🖐️ hand fingers, ✌️ peace victory, 🤞 fingers crossed luck, 🤟 love you, 🤘 rock on, 👌 ok perfect, 🤌 pinched chef, 👈 point left, 👉 point right, 👆 point up, 👇 point down, ☝️ index up one, ✊ fist raised, 👊 punch fist bump, 💪 muscle strong flex, 🫶 heart hands love, 🫡 salute respect, 🧠 brain think smart, 👀 eyes look, 👁️ eye see"
    ),
  },
  {
    label: "Hearts",
    items: list(
      "❤️ red heart love, 🧡 orange heart, 💛 yellow heart, 💚 green heart, 💙 blue heart, 💜 purple heart, 🖤 black heart, 🤍 white heart, 🤎 brown heart, 💖 sparkling heart, 💗 growing heart, 💓 beating heart, 💕 two hearts, 💞 revolving hearts, 💘 cupid arrow, 💝 heart gift ribbon, 💔 broken heart, ❣️ heart exclamation, ❤️‍🔥 heart on fire, 💯 hundred, 💢 anger, 💥 collision boom, 💫 dizzy star, 💦 sweat drops, 💨 dash fast, 💬 speech bubble chat, 💭 thought bubble, 🗯️ anger bubble, 💤 zzz sleep"
    ),
  },
  {
    label: "Celebrate",
    items: list(
      "🎉 party popper tada, 🎊 confetti ball, 🎈 balloon, 🎁 gift present, 🎂 birthday cake, 🍾 champagne bottle, 🥂 cheers toast, 🎆 fireworks, 🎇 sparkler, ✨ sparkles, 🌟 glowing star, ⭐ star, 🏆 trophy, 🥇 gold medal first, 🥈 silver medal second, 🥉 bronze medal third, 🏅 medal sports, 🎖️ military medal honour, 👑 crown king queen, 💎 diamond gem premium, 🎯 target dart, 🎮 game controller, 🎬 clapper film action, 🎤 microphone sing, 🎧 headphones music, 🎵 music note, 🎶 notes music, 🎸 guitar, 🥁 drum"
    ),
  },
  {
    label: "Work",
    items: list(
      "💼 briefcase business, 📈 chart up growth, 📉 chart down decline, 📊 bar chart stats, 💰 money bag, 💵 dollar cash, 💸 money flying spend, 💳 credit card pay, 🧾 receipt, 📅 calendar date, 📆 tear-off calendar, ⏰ alarm clock time, ⏳ hourglass waiting, ⌛ hourglass done, 📌 pushpin, 📍 location pin, 📎 paperclip attach, ✏️ pencil write, 📝 memo notes, 📚 books learn, 📖 open book read, 🎓 graduation cap degree, 🏫 school, 💻 laptop computer, 🖥️ desktop, ⌨️ keyboard, 🖱️ mouse, 📱 phone mobile, 📞 telephone call, 📧 email, 📨 incoming mail, 📣 megaphone announce, 📢 loudspeaker, 🔔 bell notification, 🔒 lock secure, 🔑 key, 🔍 search magnify, 💡 bulb idea, 🔧 wrench fix, ⚙️ gear settings, 🧩 puzzle piece, 🗂️ folders organise, 📦 package box shipping, 🛒 shopping cart, 🏷️ label tag price"
    ),
  },
  {
    label: "Nature",
    items: list(
      "🌍 globe africa europe world, 🌎 globe americas, 🌏 globe asia, 🌞 sun face, ☀️ sun sunny, 🌙 moon night, ⭐ star, 🌈 rainbow, ☁️ cloud, ⛅ sun cloud, 🌧️ rain, ⛈️ storm, ❄️ snowflake cold winter, 🔥 fire, 💧 droplet water, 🌊 wave ocean sea, 🌱 seedling growth, 🌿 herb leaf, 🍀 clover luck, 🌳 tree, 🌴 palm tree tropical, 🌵 cactus, 🌸 cherry blossom, 🌻 sunflower, 🌹 rose, 🍁 maple leaf autumn, 🐶 dog puppy, 🐱 cat kitty, 🦁 lion, 🐯 tiger, 🐻 bear, 🐼 panda, 🦊 fox, 🐵 monkey, 🦄 unicorn, 🐝 bee, 🦋 butterfly, 🐢 turtle slow, 🐙 octopus, 🦉 owl wise"
    ),
  },
  {
    label: "Food",
    items: list(
      "☕ coffee hot drink, 🍵 tea, 🧃 juice box, 🥤 cup drink soda, 🍺 beer, 🍷 wine, 🍕 pizza, 🍔 burger, 🍟 fries, 🌭 hot dog, 🌮 taco, 🍿 popcorn movie, 🍩 doughnut, 🍪 cookie, 🍫 chocolate, 🍰 cake slice, 🧁 cupcake, 🍦 ice cream, 🍎 apple, 🍌 banana, 🍓 strawberry, 🍉 watermelon, 🍍 pineapple, 🥑 avocado, 🌶️ chilli hot spicy, 🍳 cooking egg, 🍜 noodles ramen, 🍣 sushi, 🍚 rice, 🥗 salad healthy"
    ),
  },
  {
    label: "Symbols",
    items: list(
      "✅ check button done, ☑️ ballot check, ✔️ check mark, ❌ cross no wrong, ❎ cross button, ➕ plus add, ➖ minus, ➗ divide, ✖️ multiply, ❓ question, ❔ white question, ❗ exclamation important, ❕ white exclamation, ‼️ double exclamation, ⁉️ interrobang, ⚠️ warning caution, 🚫 prohibited no, ⛔ no entry stop, 🔴 red circle live, 🟠 orange circle, 🟡 yellow circle, 🟢 green circle go, 🔵 blue circle, 🟣 purple circle, ⚫ black circle, ⚪ white circle, 🔺 red triangle up, 🔻 red triangle down, ➡️ right arrow, ⬅️ left arrow, ⬆️ up arrow, ⬇️ down arrow, ↗️ up right arrow, 🔄 repeat refresh, 🔁 loop repeat, ▶️ play, ⏸️ pause, ⏹️ stop, ⏭️ next track, 🆕 new button, 🆓 free, 🆗 ok button, 🆒 cool, 🔝 top, 🔜 soon, 💲 dollar sign, ©️ copyright, ®️ registered, ™️ trademark, #️⃣ hash number, 1️⃣ one first, 2️⃣ two second, 3️⃣ three third"
    ),
  },
];

// Emoji whose words contain every word of `query` (or that are the query itself).
export function searchEmoji(query: string): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: EmojiEntry[] = [];
  for (const cat of EMOJI_CATEGORIES)
    for (const e of cat.items) {
      if (seen.has(e.char)) continue;
      const hay = `${e.words} ${cat.label}`.toLowerCase();
      if (words.length === 0 || e.char === query.trim() || words.every((w) => hay.includes(w))) {
        seen.add(e.char);
        out.push(e);
      }
    }
  return out;
}
