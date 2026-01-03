# INFO panel help inventory (auto-generated)
This file lists *static* UI controls found in `index.html` (modals excluded). Use it to ensure every control has a corresponding entry in `mddt-hover-help-registry.js`.
Tip: In the running app, open the browser console and run `MDDTHoverHelp.audit()` to see missing keys.
## Panel: `midi`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<button> .tool-button` | Firmware | onclick=openFirmwareUpdateModal() |
| #bulkCancelReceiveBtn | `<button> #bulkCancelReceiveBtn .bulk-cancel-btn` | Cancel | onclick=cancelBulkOperation('receive') |
| #bulkCancelSendBtn | `<button> #bulkCancelSendBtn .bulk-cancel-btn` | Cancel | onclick=cancelBulkOperation('send') |
| #recvCheckG | `<input> #recvCheckG` |  |  |
| #recvCheckK | `<input> #recvCheckK` |  |  |
| #recvCheckP | `<input> #recvCheckP` |  |  |
| #recvCheckS | `<input> #recvCheckS` |  |  |
| #resetCheckG | `<input> #resetCheckG` |  |  |
| #resetCheckK | `<input> #resetCheckK` |  |  |
| #resetCheckP | `<input> #resetCheckP` |  |  |
| #resetCheckS | `<input> #resetCheckS` |  |  |
| #sendCheckG | `<input> #sendCheckG` |  |  |
| #sendCheckK | `<input> #sendCheckK` |  |  |
| #sendCheckP | `<input> #sendCheckP` |  |  |
| #sendCheckS | `<input> #sendCheckS` |  |  |
| tools:receive:all | `<button> .tool-button` | ALL | onclick=onClickReceiveAll(); data-pulse-scope=receive; data-pulse-target=all |
| tools:receive:globals | `<button> .tool-button` | Global | onclick=requestGlobalDump(); data-pulse-target=globals |
| tools:receive:globals | `<button> .tool-button` | Global | onclick=onClickWriteGlobal(); data-pulse-target=globals |
| tools:receive:kits | `<button> .tool-button` | Kit | onclick=requestKitDump(); data-pulse-target=kits |
| tools:receive:kits | `<button> .tool-button` | Kit | onclick=saveCurrentKitToMD(); data-pulse-target=kits |
| tools:receive:patterns | `<button> .tool-button` | Pattern | onclick=requestPatternDump(); data-pulse-target=patterns |
| tools:receive:patterns | `<button> .tool-button` | Pattern | onclick=writePatternToMD(); data-pulse-target=patterns |
| tools:receive:songs | `<button> .tool-button` | Song | onclick=requestSongDump(); data-pulse-target=songs |
| tools:receive:songs | `<button> .tool-button` | Song | onclick=saveCurrentSongToMD(); data-pulse-target=songs |
| tools:send:all | `<button> .tool-button` | ALL | onclick=onClickSendAll(); data-pulse-scope=send; data-pulse-target=all |
| tools:slotops:clear | `<button> .tool-button` | Clear | onclick=onClickSlotsClear(); data-pulse-scope=slotops; data-pulse-target=clear |
| tools:slotops:copy | `<button> .tool-button` | Copy | onclick=onClickSlotsCopy(); data-pulse-scope=slotops; data-pulse-target=copy |
| tools:slotops:paste | `<button> .tool-button` | Paste | onclick=onClickSlotsPaste(); data-pulse-scope=slotops; data-pulse-target=paste |

## Panel: `kit`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<button> .kit-tab` | Effects |  |
|  | `<button> .kit-tab` | Master FX |  |
|  | `<button> .kit-tab` | Overview |  |
|  | `<button> .kit-tab` | Routing |  |
|  | `<button> .kit-tab` | Synthesis |  |
| #kitNameInput | `<input> #kitNameInput` |  |  |

## Panel: `pattern`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<summary>` | Locks / Parameter steps |  |
| #accentSlider | `<input> #accentSlider` | Accent |  |
| #assignedKitNumber | `<input> #assignedKitNumber` | Kit # |  |
| #patLengthSlider | `<input> #patLengthSlider` | Length |  |
| #patNumber | `<input> #patNumber` | Pat # |  |
| #patScaleSelect | `<select> #patScaleSelect` | Scale |  |
| #patSwingSlider | `<input> #patSwingSlider` | Swing |  |
| #patTempoMult | `<select> #patTempoMult` | Tempo |  |

## Panel: `song`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
| #songNameInput | `<input> #songNameInput` |  |  |

## Panel: `global`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<summary>` | Advanced |  |
| #globalClockIn | `<input> #globalClockIn` |  |  |
| #globalClockOut | `<input> #globalClockOut` |  |  |
| #globalDrumLeft | `<select> #globalDrumLeft` | Destination: |  |
| #globalDrumRight | `<select> #globalDrumRight` | Destination: |  |
| #globalExtendedMode | `<input> #globalExtendedMode` | Extended Mode |  |
| #globalGateLeft | `<input> #globalGateLeft` | Gate: |  |
| #globalGateRight | `<input> #globalGateRight` | Gate: |  |
| #globalKeymapClearFilter | `<button> #globalKeymapClearFilter .tool-button` | Clear |  |
| #globalKeymapFilter | `<input> #globalKeymapFilter` | Filter: |  |
| #globalKeymapTitle | `<summary> #globalKeymapTitle` | Keymap |  |
| #globalLocalOn | `<input> #globalLocalOn` | Local On |  |
| #globalMaxLevelLeft | `<input> #globalMaxLevelLeft` | VMax: |  |
| #globalMaxLevelRight | `<input> #globalMaxLevelRight` | VMax: |  |
| #globalMechSettingsSelect | `<select> #globalMechSettingsSelect` | Mechanical Settings: |  |
| #globalMidiBaseSelect | `<select> #globalMidiBaseSelect` | MIDI Base Channel: |  |
| #globalMinLevelLeft | `<input> #globalMinLevelLeft` | VMin: |  |
| #globalMinLevelRight | `<input> #globalMinLevelRight` | VMin: |  |
| #globalPcChannelSelect | `<select> #globalPcChannelSelect` | Program Change Channel: |  |
| #globalProgramChangeSelect | `<select> #globalProgramChangeSelect` | Program Change: |  |
| #globalSenseLeft | `<input> #globalSenseLeft` | Sense: |  |
| #globalSenseRight | `<input> #globalSenseRight` | Sense: |  |
| #globalTempo | `<input> #globalTempo` | Tempo: |  |
| #globalTransportIn | `<input> #globalTransportIn` |  |  |
| #globalTransportOut | `<input> #globalTransportOut` |  |  |
| #globalTrigModeSelect | `<select> #globalTrigModeSelect` | Trigger Mode: |  |

## Panel: `uw`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<button>` | Auto Repitch | onclick=autoRepitchAll() |
|  | `<button>` | Clear Active Slot | onclick=clearSlot() |
|  | `<button>` | Clear All | onclick=clearAllSlots() |
|  | `<button>` | Export Bank | onclick=exportAllSlots() |
|  | `<button>` | Import Audio | onclick=openImportAudioModal() |
|  | `<button>` | Import Bank | onclick=openImportDataModal() |
|  | `<button>` | Randomise All Slots Rate+Pitch | onclick=randomiseAllSlots() |
|  | `<button>` | Receive Active Slot | onclick=receiveActiveSlot() |
|  | `<button>` | Receive All | onclick=startBulkReceiveAll() |
|  | `<button>` | Request Slot List to Receive | onclick=requestSlotList() |
|  | `<button>` | Send Active Slot | onclick=sendActiveSample() |
|  | `<button>` | Send All | onclick=sendAllSamples() |
| #bulkCancelBtn | `<button> #bulkCancelBtn .bulkCancelBtn` | Cancel | onclick=cancelUwBulkOperation() |
| #openLoopRecvGlobal | `<input> #openLoopRecvGlobal` |  |  |
| #openLoopSendGlobal | `<input> #openLoopSendGlobal` |  |  |
| #uwFileInput | `<input> #uwFileInput` |  |  |

## Panel: `app`
| Suggested key | Element | Label | onclick / data |
|---|---|---|---|
|  | `<summary> .slot-group-title` | INFO |  |
| #systemMidiLauncher | `<button> #systemMidiLauncher .brand--hero` | MDDT |  |
| nav:global | `<button> .nav-btn` | Global | data-panel=global |
| nav:help | `<button> .nav-btn` | Help | data-panel=help |
| nav:kit | `<button> .nav-btn` | Kit | data-panel=kit |
| nav:lab | `<button> .nav-btn` | Lab | data-panel=lab |
| nav:midi | `<button> .nav-btn` | Tools | data-panel=midi |
| nav:nodetrix | `<button> .nav-btn` | Nodetrix | data-panel=nodetrix |
| nav:pattern | `<button> .nav-btn` | Pattern | data-panel=pattern |
| nav:skewclid | `<button> .nav-btn` | Skewclid | data-panel=skewclid |
| nav:song | `<button> .nav-btn` | Song | data-panel=song |
| nav:uw | `<button> .nav-btn` | UW | data-panel=uw |

