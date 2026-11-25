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
      "🔥 fire hot lit trending, ✨ sparkles magic new, 🎉 party celebrate tada, 🚀 rocket launch fast, 💯 hundred perfect score, ✅ check done yes, ❤️ heart love red, 🙏 pray please thanks grateful, 🤩 star struck wow amazed, 🫡 salute respect yes sir, 🤦‍♂️ facepalm man duh oops, 🤦‍♀️ facepalm woman duh oops, 🤷‍♀️ shrug woman dunno whatever, 🤷‍♂️ shrug man dunno whatever, 🥹 holding back tears touched proud, 🫶 heart hands love, 😂 laugh tears joy, 😭 sobbing crying laugh, 🥳 party face celebrate, 😍 heart eyes love, 🤔 thinking hmm question, 🤯 mind blown wow, 💀 skull dead, 👏 clap applause, 🙌 raised hands praise yay, 👀 eyes look watch, 💡 idea bulb tip, ⭐ star favourite, 🏆 trophy win award, 💪 strong muscle power, 👉 point right this, 📌 pin important, ⚡ bolt fast energy, 🎯 target goal bullseye, 💥 boom explode impact"
    ),
  },
  {
    label: "Smileys",
    items: list(
      "😀 grin happy smile, 😃 smile happy open, 😄 smile eyes happy, 😁 beaming grin, 😆 laughing squint, 😅 sweat smile phew, 🤣 rofl rolling laugh, 😂 tears joy laugh, 🙂 slight smile, 🙃 upside down silly, 🫠 melting face hot awkward, 😉 wink, 😊 blush smile, 😇 angel innocent, 🥰 love hearts, 😍 heart eyes, 🤩 star struck wow amazed, 😘 kiss, 😋 yum tasty, 😛 tongue, 😜 wink tongue crazy, 🤪 zany crazy, 🤑 money mouth rich, 🤗 hug, 🤭 oops giggle, 🫢 hand over mouth gasp, 🫣 peeking eye shy, 🤫 shush quiet secret, 🤔 thinking, 🫡 saluting face respect, 🤐 zip mouth secret, 🤨 raised eyebrow skeptical, 😐 neutral meh, 😑 expressionless, 😶 no mouth speechless, 🫥 dotted line face invisible, 😏 smirk, 😒 unamused, 🙄 eye roll, 😬 grimace awkward, 😮‍💨 exhaling sigh relief, 😌 relieved calm, 😔 pensive sad, 😪 sleepy, 🤤 drooling, 😴 sleeping zzz, 😷 mask sick, 🤒 sick fever, 🤕 bandage hurt, 🤢 nauseated sick, 🥵 hot face heat, 🥶 cold face freezing, 🥴 woozy dizzy, 😵 dizzy knockout, 😵‍💫 dizzy spiral eyes, 🤯 mind blown exploding, 🤠 cowboy hat, 🥳 partying celebrate, 🥸 disguised glasses, 😎 cool sunglasses, 🤓 nerd geek, 🧐 monocle inspect, 😕 confused, 🫤 diagonal mouth meh, 😟 worried, 🙁 slightly frowning, 😮 open mouth surprised, 😲 astonished shocked, 😳 flushed embarrassed, 🥺 pleading puppy eyes, 🥹 holding back tears touched, 😦 frowning open mouth, 😨 fearful scared, 😰 anxious sweat, 😢 crying sad tear, 😭 sobbing crying, 😱 scream fear, 😖 confounded, 😣 persevering, 😞 disappointed, 😓 downcast sweat, 😫 tired, 😤 huff determined, 😡 angry pout, 🤬 cursing angry, 😈 smiling devil horns, 👿 angry devil, 💀 skull dead, 💩 poop, 🤡 clown, 👻 ghost boo, 👽 alien, 🤖 robot ai bot, 🙈 see no evil monkey, 🙉 hear no evil monkey, 🙊 speak no evil monkey"
    ),
  },
  {
    label: "People",
    items: list(
      "🤦‍♂️ man facepalming duh oops, 🤦‍♀️ woman facepalming duh oops, 🤦 person facepalming duh, 🤦🏻‍♂️ man facepalming light skin, 🤷‍♂️ man shrugging dunno, 🤷‍♀️ woman shrugging dunno, 🤷 person shrugging dunno, 🤷🏻‍♀️ woman shrugging light skin, 🙅‍♂️ man gesturing no stop, 🙅‍♀️ woman gesturing no stop, 🙆‍♂️ man gesturing ok, 🙆‍♀️ woman gesturing ok, 🙋‍♂️ man raising hand question, 🙋‍♀️ woman raising hand question, 🙇‍♂️ man bowing sorry thanks, 🙇‍♀️ woman bowing sorry thanks, 💁‍♂️ man tipping hand info, 💁‍♀️ woman tipping hand info, 👤 bust silhouette person user, 👥 busts people group team, 🫂 people hugging embrace, 🗣️ speaking head talk voice, 👶 baby, 👧 girl, 🧒 child, 👦 boy, 👩 woman, 🧑 person, 👨 man, 👴 older man, 👵 older woman, 👨‍💻 man technologist developer code, 👩‍💻 woman technologist developer code, 👨‍🔬 man scientist physics chemistry, 👩‍🔬 woman scientist physics chemistry, 👨‍🏫 man teacher professor lecture, 👩‍🏫 woman teacher professor lecture, 👨‍🎓 man student graduate, 👩‍🎓 woman student graduate, 👨‍⚕️ man doctor health, 👩‍⚕️ woman doctor health, 👨‍🎨 man artist design, 👩‍🎨 woman artist design, 👨‍🚀 man astronaut space, 👩‍🚀 woman astronaut space, 🦸 superhero, 🧙 mage wizard, 🏃 runner fast sprint, 🚶 walking person, 💃 woman dancing party, 🕺 man dancing party, 🧘 meditating calm yoga, 🏋️ lifting weights gym"
    ),
  },
  {
    label: "Gestures",
    items: list(
      "👍 thumbs up like yes good, 👎 thumbs down dislike no, 👏 clap applause, 🙌 raised hands praise, 🫶 heart hands love, 👐 open hands, 🤝 handshake deal partner, 🙏 pray please thanks, ✍️ writing hand write, 💅 nail polish, 👋 wave hello bye, 🤚 raised back hand, 🖐️ hand fingers, ✋ hand stop, 🖖 vulcan salute, 🫱 rightward hand, 🫲 leftward hand, 🫳 palm down, 🫴 palm up, 👌 ok perfect, 🤌 pinched chef, 🤏 pinching small, ✌️ peace victory, 🤞 fingers crossed luck, 🫰 hand index thumb crossed snap money, 🤟 love you, 🤘 rock on, 🤙 call me shaka, 👈 point left, 👉 point right, 👆 point up, 👇 point down, ☝️ index up one, 🫵 pointing at you, ✊ fist raised, 👊 punch fist bump, 🤛 left fist, 🤜 right fist, 💪 muscle strong flex, 🦾 mechanical arm robot, 🦵 leg, 🦶 foot, 👂 ear listen, 👃 nose smell, 🧠 brain think smart, 🫀 anatomical heart, 🫁 lungs, 🦷 tooth, 👅 tongue, 👄 lips mouth, 💋 kiss mark, 👣 footprints, 👀 eyes look, 👁️ eye see, 🫡 salute respect"
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
