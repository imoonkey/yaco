/** Curated word lists for memorable default session names.
 *  Format: <provider>-<adj>-<adj>-<noun>-<6hex> */

export const ADJECTIVES: readonly string[] = [
  // vibe & mood
  "swift", "bold", "calm", "wild", "keen",
  "chill", "epic", "witty", "sly", "brave",
  "zen", "hyper", "rad", "slick", "vivid",
  "brisk", "cool", "deft", "eager", "fierce",
  "gritty", "jolly", "lucid", "mellow", "nimble",
  "peppy", "quirky", "steady", "wry", "zesty",
  "spry", "gutsy", "savvy", "snappy", "plucky",
  "rowdy", "perky", "feisty", "giddy", "suave",
  "hardy", "noble", "proud", "rogue", "saucy",
  "daring", "lively", "merry", "snug", "wired",
  "heady", "frank", "avid", "edgy", "primo",
  "solid", "cozy", "spicy", "punchy", "mod",
  // sensory & physical
  "neon", "fuzzy", "tiny", "vast", "loud",
  "soft", "crisp", "bright", "icy", "warm",
  "hazy", "lush", "sharp", "shiny", "sonic",
  "polar", "misty", "rusty", "dusty", "silky",
  "golden", "cosmic", "rapid", "mossy", "stormy",
  "amber", "jade", "coral", "ivory", "onyx",
  "smoky", "sandy", "lunar", "ashen", "rosy",
  "minty", "plush", "teal", "ruby", "lilac",
  "frosty", "tangy", "dense", "inky", "opal",
  "copper", "pastel", "pewter", "cobalt", "azure",
  // tempo & energy
  "turbo", "zippy", "lazy", "hasty", "fleet",
  "hyped", "tense", "smooth", "bumpy", "airy",
  "breezy", "muggy", "balmy", "steamy", "damp",
  "sleek", "raw", "snowy", "windy", "cloudy",
  "sunny", "foggy", "rainy", "humid", "dry",
  "fresh", "stale", "thick", "lean", "grand",
  // scale & form
  "petite", "mega", "ultra", "proto", "nano",
  "micro", "macro", "apex", "max", "mini",
  "hefty", "slim", "flat", "deep", "wide",
  "steep", "round", "tall", "short", "curvy",
  "rigid", "fluid", "stark", "dim", "lit",
  "muted", "blunt", "odd", "rare", "terse",
  // color & texture
  "burnt", "gilt", "matte", "glossy", "grainy",
  "woven", "knit", "frosted", "etched", "glazed",
  "pearly", "chrome", "bronze", "silver", "scarlet",
  "violet", "indigo", "lemon", "olive", "sage",
  "cream", "slate", "mocha", "khaki", "denim",
  "suede", "satin", "linen", "hemp", "tweed",
] as const;

export const NOUNS: readonly string[] = [
  // animals
  "fox", "panda", "otter", "raven", "cobra",
  "lynx", "shark", "hawk", "wolf", "squid",
  "koala", "gecko", "falcon", "mantis", "lemur",
  "toucan", "badger", "coyote", "owl", "puma",
  "ferret", "bison", "parrot", "jackal", "condor",
  "moose", "sloth", "heron", "viper", "crane",
  "newt", "wren", "mole", "finch", "stork",
  "quail", "robin", "toad", "beetle", "osprey",
  "iguana", "walrus", "salmon", "hornet", "chimp",
  // space & tech
  "rocket", "comet", "laser", "bolt", "prism",
  "pixel", "quasar", "nova", "spark", "orbit",
  "photon", "nebula", "pulsar", "warp", "cipher",
  "vertex", "flux", "helix", "matrix", "vector",
  "beacon", "signal", "tensor", "voxel", "node",
  "binary", "codec", "kernel", "daemon", "proxy",
  "patch", "gizmo", "servo", "diode", "modem",
  // food & drink
  "taco", "mochi", "waffle", "ramen", "donut",
  "mango", "lemon", "berry", "olive", "pretzel",
  "churro", "kimchi", "gyoza", "fudge", "salsa",
  "sushi", "pizza", "crepe", "bagel", "crumb",
  "nacho", "toast", "curry", "broth", "syrup",
  "cocoa", "peach", "plum", "melon", "guava",
  "sorbet", "truffle", "matcha", "brioche", "gummy",
  // myths & characters
  "ninja", "titan", "golem", "phoenix", "dragon",
  "yeti", "hydra", "sphinx", "kraken", "wizard",
  "pirate", "bandit", "viking", "samurai", "ronin",
  "djinn", "gnome", "sprite", "ogre", "troll",
  "mimic", "wraith", "knight", "bard", "druid",
  "ranger", "cleric", "sage", "monk", "paladin",
  // objects & misc
  "anvil", "anchor", "arrow", "badge", "blade",
  "cannon", "crown", "dagger", "ember", "flare",
  "glyph", "hammer", "lantern", "jewel", "mirror",
  "quill", "riddle", "shield", "throne", "trophy",
  "vault", "wand", "zenith", "forge", "scroll",
  "relic", "charm", "sigil", "totem", "amulet",
  // nature & places
  "canyon", "reef", "delta", "mesa", "grove",
  "ridge", "summit", "ravine", "glacier", "lagoon",
  "crater", "dune", "atoll", "tundra", "steppe",
  // music & sound
  "bass", "riff", "chord", "tempo", "fugue",
  "gong", "drum", "lute", "banjo", "kazoo",
] as const;
