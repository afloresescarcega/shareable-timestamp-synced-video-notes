# Timestamp-Synced Video Notes

A companion to dense, talking-head videos (e.g. complex history) that surfaces visuals at the moments where following the narration depends on context the viewer doesn't currently have.

## Source material

**Video**:
A single YouTube video, identified by its video ID.

**Section**:
A contiguous span of a Video, taken from the creator's chapters or, when the Video has none, proposed by the AI and labelled as such.
_Avoid_: Chapter, segment, part

**Transcript**:
The timed text of what is said in a Video; the primary source for everything the notes contain.
_Avoid_: Captions, subtitles

## Things the narration talks about

**Entity**:
A Person, Place, or Event mentioned in the Video.
_Avoid_: Item, thing, topic

**Person**:
An individual mentioned in the Video.

**Place**:
A geographic location mentioned in the Video.
_Avoid_: Location

**Located place**:
A Place whose position is known; shown as a pin.

**Uncertain place**:
A real Place whose exact position is disputed or lost; shown as an approximate area, never a pin.

**Unmappable place**:
A legendary Place, or one known only relative to other Places; shown as a labelled schematic sketch, not on a real map.

**Event**:
Something that happened, with a date or date range (e.g. a battle, a reign).

**Relationship**:
A named link between two People (e.g. "son of", "betrayed").

**Mention**:
A single point in the Transcript where an Entity is referred to, by name or indirectly ("the king"). Deciding which Entity a Mention refers to can be wrong and is correctable by merging or splitting Entities.

**First mention**:
The moment in the Video where an Entity is first introduced; the point a Callback refers back to.

## Cues

**Cue**:
A moment in the Video where following the narration depends on context the viewer doesn't currently have. A plainly stated fact is not a Cue.
_Avoid_: Highlight, annotation, popup

**Callback**:
A Cue where the narration refers back to an Entity from earlier in the same Video (e.g. "the son of the king we discussed").
_Avoid_: Back-reference

**Gap**:
A Cue where the narration assumes context the Video never provides (e.g. a city named but never located).
_Avoid_: Missing context

**Outside knowledge**:
Content in a Cue that does not come from the Video itself; always shown as such, because it is less trustworthy.

## Cue visuals

**Relationship card**:
A small diagram linking the current Person to the related People it depends on.
_Avoid_: Who's-who card, family tree

**Map**:
A visual placing the current Place among the earlier related Places, each labelled with when it mattered.

**Timeline**:
A visual placing the current Event among the earlier related Events.

## The artifact

**Notes**:
The full set of generated-and-edited material for one Video; the unit that is saved and shared.
_Avoid_: Annotations, visuals, companion data

**Draft**:
Notes as produced by the AI, before any user edits.

**Prepare**:
Reading a Video's whole Transcript once, up front, to produce its Draft; only possible when the Video has a Transcript.
