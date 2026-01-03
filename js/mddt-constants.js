// constants.js

(function () {
  // --- Machinedrum Sysex Message IDs ---
  const MD_GLOBAL_MESSAGE_ID      = 0x50;
  const MD_GLOBAL_REQUEST_ID      = 0x51;
  const MD_KIT_MESSAGE_ID         = 0x52;
  const MD_KIT_REQUEST_ID         = 0x53;
  const MD_CUSTOM_SAVE_KIT_ID     = 0x54;
  const MD_PATTERN_MESSAGE_ID     = 0x67;
  const MD_PATTERN_REQUEST_ID     = 0x68;
  const MD_CUSTOM_SAVE_PATTERN_ID = 0x6B;
  const MD_SONG_MESSAGE_ID        = 0x69;
  const MD_SONG_REQUEST_ID        = 0x6A;
  const MD_LOAD_SONG_ID           = 0x6C;
  const MD_SAVE_SONG_ID           = 0x6D;

  // Common sysex header for Machinedrum messages
  const MD_SYSEX_HEADER = [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];

  // Clamping helper (0..127)
  const clamp = (n) => Math.max(0, Math.min(127, n));

  // Swing boundaries and LFO wave count
  const MD_SWING_MIN = 50;
  const MD_SWING_MAX = 80;
  const MD_LFO_WAVE_COUNT = 11;

  // Model constants for MKI vs MKII
  const MD_MODEL_CONSTS = {
    MKI: {
      maxPatternLength: 32,
      romSlotCount: 32,
      ramRecordPlayCount: 2
    },
    MKII: {
      maxPatternLength: 64,
      romSlotCount: 48,
      ramRecordPlayCount: 4
    }
  };

  // Expose these constants globally
  Object.assign(window, {
    MD_GLOBAL_MESSAGE_ID,
    MD_GLOBAL_REQUEST_ID,
    MD_KIT_MESSAGE_ID,
    MD_KIT_REQUEST_ID,
    MD_CUSTOM_SAVE_KIT_ID,
    MD_PATTERN_MESSAGE_ID,
    MD_PATTERN_REQUEST_ID,
    MD_CUSTOM_SAVE_PATTERN_ID,
    MD_SONG_MESSAGE_ID,
    MD_SONG_REQUEST_ID,
    MD_LOAD_SONG_ID,
    MD_SAVE_SONG_ID,
    MD_SYSEX_HEADER,
    clamp,
    MD_SWING_MIN,
    MD_SWING_MAX,
    MD_LFO_WAVE_COUNT,
    MD_MODEL_CONSTS
  });

  // By default, set some global flags if needed
  window.mdModel = "MKII";
  window.mdUWEnabled = true;
  window.mdOSVersion = "X";
})();

 // MACHINE & FX LABELS
(function () {
  // Full machine names (IDs 0..191)
  const FULL_MACHINE_NAMES = {
    0:  "GND-EMPTY", 1: "GND-SN-PRO", 2: "GND-NS", 3: "GND-IM",
    4:  "GND-SW", 5:  "GND-PU", 6:  "(unused #6)",
    7:  "NFX-EV", 8:  "NFX-CO", 9:  "NFX-UC",
    10: "(unused #10)", 11: "(unused #11)", 12: "(unused #12)", 13: "(unused #13)",
    14: "(unused #14)", 15: "(unused #15)",
    16: "TRX-BD", 17: "TRX-SD", 18: "TRX-XT", 19: "TRX-CP",
    20: "TRX-RS", 21: "TRX-CB", 22: "TRX-CH", 23: "TRX-OH",
    24: "TRX-CY", 25: "TRX-MA", 26: "TRX-CL", 27: "TRX-XC",
    28: "TRX-B2", 29: "TRX-S2",
    30: "(unused #30)", 31: "(unused #31)",
    32: "EFM-BD", 33: "EFM-SD", 34: "EFM-XT", 35: "EFM-CP",
    36: "EFM-RS", 37: "EFM-CB", 38: "EFM-HH", 39: "EFM-CY",
    40: "(unused #40)", 41: "(unused #41)", 42: "(unused #42)", 43: "(unused #43)",
    44: "(unused #44)", 45: "(unused #45)", 46: "(unused #46)", 47: "(unused #47)",
    48: "E12-BD", 49: "E12-SD", 50: "E12-HT", 51: "E12-LT",
    52: "E12-CP", 53: "E12-RS", 54: "E12-CB", 55: "E12-CH",
    56: "E12-OH", 57: "E12-RC", 58: "E12-CC", 59: "E12-BR",
    60: "E12-TA", 61: "E12-TR", 62: "E12-SH", 63: "E12-BC",
    64: "PI-BD", 65: "PI-SD", 66: "PI-MT", 67: "PI-ML", 68: "PI-MA",
    69: "PI-RS", 70: "PI-RC", 71: "PI-CC", 72: "PI-HH",
    73: "(unused #73)", 74: "(unused #74)", 75: "(unused #75)",
    76: "(unused #76)", 77: "(unused #77)", 78: "(unused #78)", 79: "(unused #79)",
    80: "INP-GA", 81: "INP-GB", 82: "INP-FA", 83: "INP-FB",
    84: "INP-EA", 85: "INP-EB", 86: "INP-CA", 87: "INP-CB",
    88: "(unused #88)", 89: "(unused #89)",
    90: "(unused #90)", 91: "(unused #91)", 92: "(unused #92)",
    93: "(unused #93)", 94: "(unused #94)", 95: "(unused #95)",
    96:  "MID-01", 97:  "MID-02", 98:  "MID-03", 99:  "MID-04",
    100: "MID-05", 101: "MID-06", 102: "MID-07", 103: "MID-08",
    104: "MID-09", 105: "MID-10", 106: "MID-11", 107: "MID-12",
    108: "MID-13", 109: "MID-14", 110: "MID-15", 111: "MID-16",
    112: "CTR-AL", 113: "CTR-8P",
    114: "(unused #114)", 115: "(unused #115)", 116: "(unused #116)",
    117: "(unused #117)", 118: "(unused #118)", 119: "(unused #119)",
    120: "CTR-RE", 121: "CTR-GB", 122: "CTR-EQ", 123: "CTR-DX",   
    124: "(unused #124)", 125: "(unused #125)", 126: "(unused #126)", 
    127: "(unused #127)",
    128: "ROM-01", 129: "ROM-02", 130: "ROM-03", 131: "ROM-04",
    132: "ROM-05", 133: "ROM-06", 134: "ROM-07", 135: "ROM-08",
    136: "ROM-09", 137: "ROM-10", 138: "ROM-11", 139: "ROM-12",
    140: "ROM-13", 141: "ROM-14", 142: "ROM-15", 143: "ROM-16",
    144: "ROM-17", 145: "ROM-18", 146: "ROM-19", 147: "ROM-20",
    148: "ROM-21", 149: "ROM-22", 150: "ROM-23", 151: "ROM-24",
    152: "ROM-25", 153: "ROM-26", 154: "ROM-27", 155: "ROM-28",
    156: "ROM-29", 157: "ROM-30", 158: "ROM-31", 159: "ROM-32",
    160: "RAM-R1", 161: "RAM-R2", 162: "RAM-P1", 163: "RAM-P2",
    165: "RAM-R3", 166: "RAM-R4", 167: "RAM-P3", 168: "RAM-P4",
    176: "ROM-33", 177: "ROM-34", 178: "ROM-35", 179: "ROM-36",
    180: "ROM-37", 181: "ROM-38", 182: "ROM-39", 183: "ROM-40",
    184: "ROM-41", 185: "ROM-42", 186: "ROM-43", 187: "ROM-44",
    188: "ROM-45", 189: "ROM-46", 190: "ROM-47", 191: "ROM-48"
  };

  // Master FX
  const masterFxNames = [
    "DVOL", "PRED", "DEC", "DAMP", "HP", "LP", "GATE", "LEV",
    "TIME", "MOD", "MFRQ", "FB", "FILTF", "FILTW", "MONO", "LEV",
    "LF", "LG", "HF", "HG", "PF", "PG", "PQ", "GAIN"
  ];

  // LFO column labels
  const lfoColLabels = ["Wave1", "Wave2", "Mode", "DestTrk", "DestParam"];

  // Default sets of labels for track FX & routing
  const DEFAULT_TRACK_FX_LABELS = ["AMD", "AMF", "EQF", "EQG", "FLTF", "FLTW", "FLTQ", "SRR"];
  const DEFAULT_ROUTING_LABELS  = ["DIST", "VOL", "PAN", "DELS", "REVS", "LFOS", "LFOD", "LFOM"];

  Object.assign(window, {
    FULL_MACHINE_NAMES,
    masterFxNames,
    lfoColLabels,
    DEFAULT_TRACK_FX_LABELS,
    DEFAULT_ROUTING_LABELS
  });
})();

// MACHINE PARAM LABELS & TONAL SUPPORT
(function () {
  const MACHINE_PARAM_LABELS = {
    0: [],
    1: ["PTCH", "DEC", "RAMP", "RDEC", "PTCH2", "PTCH3", "PTCH4", "UNI"],
    2: ["DEC"],
    3: ["UP", "UVAL", "DOWN", "DVAL"],
    4: ["PTCH", "DEC", "RAMP", "RDEC", "PTCH2", "PTCH3", "SKEW", "UNI"],
    5: ["PTCH", "DEC", "RAMP", "RDEC", "PTCH2", "PTCH3", "WIDTH", "UNI"],
    6: [],
    7: ["DEL", "ATK", "DEC", "SUS", "HOLD", "REL", "RING", "NBAL"],
    8: ["ATT", "REL", "THRE", "RTIO", "KNEE", "SIDE", "MKUP", "NBAL"],
    9: ["TIM1", "TIM2", "TD", "TI", "FF", "FB", "DMIX", "NBAL"],
    10: [], 11: [], 12: [], 13: [], 14: [], 15: [],
    16: ["PTCH", "DEC", "RAMP", "RDEC", "STRT", "NOIS", "HARM", "CLIP"],
    17: ["PTCH", "DEC", "BUMP", "BENV", "SNAP", "TONE", "TUNE", "CLIP"],
    18: ["PTCH", "DEC", "RAMP", "RDEC", "DAMP", "DIST", "DTYP"],
    19: ["CLPY", "TONE", "HARD", "RICH", "RATE", "ROOM", "RSIZ", "RTUN"],
    20: ["PTCH", "DEC", "DIST"],
    21: ["PTCH", "DEC", "ENH", "DAMP", "TONE", "BUMP"],
    22: ["GAP", "DEC", "HPF", "LPF", "MTAL"],
    23: ["GAP", "DEC", "HPF", "LPF", "MTAL"],
    24: ["RICH", "DEC", "TOP", "TTUN", "SIZE", "PEAK"],
    25: ["ATT", "SUS", "REV", "DAMP", "RATL", "RTYP", "TONE", "HARD"],
    26: ["PTCH", "DEC", "DUAL", "ENH", "TUNE", "CLIC"],
    27: ["PTCH", "DEC", "RAMP", "RDEC", "DAMP", "DIST", "DTYP"],
    28: ["PTCH", "DEC", "RAMP", "HOLD", "TICK", "NOIS", "DIRT", "DIST"],
    29: ["PTCH", "DEC", "NOISE", "NDEC", "POWER", "TUNE", "NTUNE", "NTYPE"],
    112: ["SYN1", "SYN2", "SYN3", "SYN4", "SYN5", "SYN6", "SYN7", "SYN8"],
    113: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P1T", "P1P",
          "P2T", "P2P", "P3T", "P3P", "P4T", "P4P", "P5T", "P5P", "P6T", "P6P",
          "P7T", "P7P", "P8T", "P8P"],
    32: ["PTCH", "DEC", "RAMP", "RDEC", "MOD", "MFRQ", "MDEC", "MFB"],
    33: ["PTCH", "DEC", "NOIS", "NDEC", "MOD", "MFRQ", "MDEC", "HPF"],
    34: ["PTCH", "DEC", "RAMP", "RDEC", "MOD", "MFRQ", "MDEC", "CLIC"],
    35: ["PTCH", "DEC", "CLPS", "CDEC", "MOD", "MFRQ", "MDEC", "HPF"],
    36: ["PTCH", "DEC", "MOD", "HPF", "SNAR", "SPTC", "SDEC", "SMOD"],
    37: ["PTCH", "DEC", "SNAP", "FB", "MOD", "MFRQ", "MDEC"],
    38: ["PTCH", "DEC", "TREM", "TFRQ", "MOD", "MFRQ", "MDEC", "FB"],
    39: ["PTCH", "DEC", "FB", "HPF", "MOD", "MFRQ", "MDEC"],
    40: [], 41: [], 42: [], 43: [], 44: [], 45: [], 46: [], 47: [],
    48: ["PTCH", "DEC", "SNAP", "SPLN", "STRT", "RTRG", "RTIM", "BEND"],
    49: ["PTCH", "DEC", "HP", "RING", "STRT", "RTRG", "RTIM", "BEND"],
    50: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    51: ["PTCH", "DEC", "HP", "RING", "STRT", "RTRG", "RTIM", "BEND"],
    52: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    53: ["PTCH", "DEC", "HP", "RRTL", "STRT", "RTRG", "RTIM", "BEND"],
    54: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    55: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    56: ["PTCH", "DEC", "HP", "STOP", "STRT", "RTRG", "RTIM", "BEND"],
    57: ["PTCH", "DEC", "HP", "BELL", "STRT", "RTRG", "RTIM", "BEND"],
    58: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    59: ["PTCH", "DEC", "HP", "REAL", "STRT", "RTRG", "RTIM", "BEND"],
    60: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    61: ["PTCH", "DEC", "HP", "HPQ", "STRT", "RTRG", "RTIM", "BEND"],
    62: ["PTCH", "DEC", "HP", "SLEW", "STRT", "RTRG", "RTIM", "BEND"],
    63: ["PTCH", "DEC", "HP", "BC", "STRT", "RTRG", "RTIM", "BEND"],
    64: ["PTCH", "DEC", "HARD", "HAMR", "TENS", "DAMP"],
    65: ["PTCH", "DEC", "HARD", "TENS", "RVOL", "RDEC", "RING"],
    66: ["PTCH", "DEC", "HARD", "HAMR", "TUNE", "DAMP", "SIZE", "POS"],
    67: ["PTCH", "DEC", "HARD", "TENS"],
    68: ["GRNS", "DEC", "GLEN", null, "SIZE", "HARD"],
    69: ["PTCH", "DEC", "HARD", "RING", "RVOL", "RDEC"],
    70: ["PTCH", "DEC", "HARD", "RING", "AG", "AU", "BR", "GRAB"],
    71: ["PTCH", "DEC", "HARD", "RING", "AG", "AU", "BR", "GRAB"],
    72: ["PTCH", "DEC", "CLSN", "RING", "AG", "AU", "BR", "CLOS"],
    73: [], 74: [], 75: [], 76: [], 77: [], 78: [], 79: [],
    80: ["VOL", "GATE", "ATCK", "HLD", "DEC"],
    81: ["VOL", "GATE", "ATCK", "HLD", "DEC"],
    82: ["ALEV", "GATE", "FATK", "FHLD", "FDEC", "FDPH", "FFRQ", "FQ"],
    83: ["ALEV", "GATE", "FATK", "FHLD", "FDEC", "FDPH", "FFRQ", "FQ"],
    84: ["AVOL", "AHLD", "ADEC", "FQ", "FDPH", "FHLD", "FDEC", "FFRQ"],
    85: ["AVOL", "AHLD", "ADEC", "FQ", "FDPH", "FHLD", "FDEC", "FFRQ"],
    86: ["ATT", "REL", "THRE", "RTIO", "KNEE", "SIDE", "MKUP", "IVOL"],
    87: ["ATT", "REL", "THRE", "RTIO", "KNEE", "SIDE", "MKUP", "IVOL"],
    88: [], 89: [], 90: [], 91: [], 92: [], 93: [], 94: [], 95: [],
    96: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    97: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    98: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    99: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    100: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    101: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    102: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    103: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    104: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    105: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    106: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    107: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    108: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    109: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    110: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    111: ["NOTE", "N2", "N3", "LEN", "VEL", "PB", "MW", "AT", "CC1D", "CC1V", "CC2D", "CC2V", "CC3D", "CC3V", "CC4D", "CC4V", "CC5D", "CC5V", "CC6D", "CC6V", "PCHG", "LFOS", "LFOD", "LFOM"],
    112: ["SYN1", "SYN2", "SYN3", "SYN4", "SYN5", "SYN6", "SYN7", "SYN8"],
    113: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P1T", "P1P",
           "P2T", "P2P", "P3T", "P3P", "P4T", "P4P", "P5T", "P5P", "P6T", "P6P",
           "P7T", "P7P", "P8T", "P8P"],
    114: [], 115: [], 116: [], 117: [], 118: [], 119: [],
    120: ["TIME","MOD","MFRQ","FB","FILTF","FILTW","MONO","LEV"],
    121: ["DVOL","PRED","DEC","DAMP","HP","LP","GATE","LEV"],
    122: ["LF","LG","HF","HG","PF","PG","PQ","GAIN"], 
    123: ["ATCK","REL","TRHD","RTIO","KNEE","HP","OUTG","MIX" ],
    124: [], 125: [], 126: [], 127: [],
    128: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    129: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    130: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    131: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    132: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    133: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    134: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    135: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    136: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    137: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    138: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    139: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    140: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    141: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    142: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    143: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    144: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    145: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    146: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    147: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    148: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    149: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    150: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    151: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    152: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    153: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    154: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    155: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    156: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    157: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    158: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    159: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    160: ["MLEV","MBAL","ILEV","IBAL","CUE1","CUE2","LEN","RATE"],
    161: ["MLEV","MBAL","ILEV","IBAL","CUE1","CUE2","LEN","RATE"],
    162: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    163: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    164: [],
    165: ["MLEV","MBAL","ILEV","IBAL","CUE1","CUE2","LEN","RATE"],
    166: ["MLEV","MBAL","ILEV","IBAL","CUE1","CUE2","LEN","RATE"],
    167: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    168: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    169: [], 170: [], 171: [], 172: [], 173: [], 174: [], 175: [],
    176: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    177: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    178: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    179: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    180: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    181: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    182: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    183: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    184: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    185: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    186: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    187: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    188: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    189: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    190: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"],
    191: ["PTCH","DEC","HOLD","BRR","STRT","END","RTRG","RTIM"]
  };

  

  const MACHINES_THAT_SUPPORT_TONAL = new Set([
    1, 4, 5, 9, 16, 17, 18, 20, 21, 26, 27, 28, 29,
    32, 33, 34, 35, 36, 37, 38
  ]);

  const X_OS_ONLY_MACHINES = [4, 5, 7, 8, 9, 29, 86, 87];

  function getParamLabels(machineID) {
    const base = MACHINE_PARAM_LABELS[machineID] || [];
    if (machineID === 1 && window.mdOSVersion === "Original") {
      return base.slice(0, 4);
    }
    return base;
  }

  Object.assign(window, {
    MACHINE_PARAM_LABELS,
    MACHINES_THAT_SUPPORT_TONAL,
    X_OS_ONLY_MACHINES,
    getParamLabels
  });
})();


(function () {
  const MD_CC_MAP = {
    // ───────────────────────────────────────────────────────────
    // Group 1: Tracks 1–4 (Base MIDI channel)
    // ───────────────────────────────────────────────────────────
    1: {
      level: 0x08,
      mute:  0x0C,
      param: [
        0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
        0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,
        0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27
      ]
    },
    2: {
      level: 0x09,
      mute:  0x0D,
      param: [
        0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,
        0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
        0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F
      ]
    },
    3: {
      level: 0x0A,
      mute:  0x0E,
      param: [
        0x48,0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,
        0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,
        0x58,0x59,0x5A,0x5B,0x5C,0x5D,0x5E,0x5F
      ]
    },
    4: {
      level: 0x0B,
      mute:  0x0F,
      param: [
        0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
        0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x6E,0x6F,
        0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77
      ]
    },

    // ───────────────────────────────────────────────────────────
    // Group 2: Tracks 5–8 (MIDI channel = baseChan+1)
    // ───────────────────────────────────────────────────────────
    5: {
      level: 0x08,
      mute:  0x0C,
      param: [
        0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
        0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,
        0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27
      ]
    },
    6: {
      level: 0x09,
      mute:  0x0D,
      param: [
        0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,
        0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
        0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F
      ]
    },
    7: {
      level: 0x0A,
      mute:  0x0E,
      param: [
        0x48,0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,
        0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,
        0x58,0x59,0x5A,0x5B,0x5C,0x5D,0x5E,0x5F
      ]
    },
    8: {
      level: 0x0B,
      mute:  0x0F,
      param: [
        0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
        0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x6E,0x6F,
        0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77
      ]
    },

    // ───────────────────────────────────────────────────────────
    // Group 3: Tracks 9–12 (MIDI channel = baseChan+2)
    // ───────────────────────────────────────────────────────────
    9: {
      level: 0x08,
      mute:  0x0C,
      param: [
        0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
        0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,
        0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27
      ]
    },
    10: {
      level: 0x09,
      mute:  0x0D,
      param: [
        0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,
        0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
        0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F
      ]
    },
    11: {
      level: 0x0A,
      mute:  0x0E,
      param: [
        0x48,0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,
        0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,
        0x58,0x59,0x5A,0x5B,0x5C,0x5D,0x5E,0x5F
      ]
    },
    12: {
      level: 0x0B,
      mute:  0x0F,
      param: [
        0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
        0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x6E,0x6F,
        0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77
      ]
    },

    // ───────────────────────────────────────────────────────────
    // Group 4: Tracks 13–16 (MIDI channel = baseChan+3)
    // ───────────────────────────────────────────────────────────
    13: {
      level: 0x08,
      mute:  0x0C,
      param: [
        0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,
        0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,
        0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27
      ]
    },
    14: {
      level: 0x09,
      mute:  0x0D,
      param: [
        0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x2E,0x2F,
        0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
        0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F
      ]
    },
    15: {
      level: 0x0A,
      mute:  0x0E,
      param: [
        0x48,0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,
        0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,
        0x58,0x59,0x5A,0x5B,0x5C,0x5D,0x5E,0x5F
      ]
    },
    16: {
      level: 0x0B,
      mute:  0x0F,
      param: [
        0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,
        0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x6E,0x6F,
        0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77
      ]
    }
  };

  window.MD_CC_MAP = MD_CC_MAP;
})();
  


// MACHINE NAME HELPERS & GLOBAL EXPOSURE
(function () {
  function getValidMachineEntries(mdModel) {
    const result = {};
    for (let i = 0; i <= 123; i++) {
      if (window.FULL_MACHINE_NAMES[i]) {
        result[i] = window.FULL_MACHINE_NAMES[i];
      }
    }
    const { romSlotCount, ramRecordPlayCount } = window.MD_MODEL_CONSTS[mdModel];
    for (let i = 0; i < Math.min(romSlotCount, 32); i++) {
      const romId = 128 + i;
      if (window.FULL_MACHINE_NAMES[romId]) {
        result[romId] = window.FULL_MACHINE_NAMES[romId];
      }
    }
    if (romSlotCount > 32) {
      for (let i = 32; i < romSlotCount; i++) {
        const romId = 176 + (i - 32);
        if (window.FULL_MACHINE_NAMES[romId]) {
          result[romId] = window.FULL_MACHINE_NAMES[romId];
        }
      }
    }
    [160,161,162,163,165,166,167,168]
      .slice(0, ramRecordPlayCount * 2)
      .forEach((id) => {
        if (window.FULL_MACHINE_NAMES[id]) {
          result[id] = window.FULL_MACHINE_NAMES[id];
        }
      });
    return result;
  }

  function getMachineNameByID(id, osVersion) {
    let name = window.FULL_MACHINE_NAMES[id] || `(unknown #${id})`;
    if (id === 1 && osVersion === "Original") {
      name = "GND-SIN";
    }
    return name;
  }

  window.getMachineName = (machineID) =>
    getMachineNameByID(machineID, window.mdOSVersion || "X");

  window.getValidMachineEntries = getValidMachineEntries;
})();