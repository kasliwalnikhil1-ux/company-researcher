// Content model for the sequence studio on /templates.
//
// Everything a user can edit lives in `Library`. Text fields hold the Markdown source exactly as
// written (escapes such as `\$` and hard breaks are kept); the recipient view is derived from it
// in emailText.ts. Fields ending in `IsDefault` / `IsSuggested` mark values the tool filled in
// because the source file does not say — the UI labels them so they are never mistaken for copy.

export type Id = string;

export interface Person {
  name: string;
  email: string;
}

/** Supporting content that is not an email: principles, examples, internal notes, or anything
 *  the importer could not map with confidence (kept verbatim and editable). */
export type BlockKind = 'guidance' | 'example' | 'note' | 'unmapped';

export interface Block {
  id: Id;
  title: string;
  kind: BlockKind;
  body: string;
  /** Heading path in the file this came from, e.g. "Outbound Sequences › Option 3 › Examples". */
  origin?: string;
}

export interface SubjectVariant {
  id: Id;
  text: string;
  origin?: string;
}

/** template = sendable copy with placeholders; example = a worked example from the source;
 *  short = the shorter high-volume version. All three are selectable for the step. */
export type VersionKind = 'template' | 'example' | 'short';

export interface Version {
  id: Id;
  name: string;
  kind: VersionKind;
  body: string;
  /** Optional preheader text. Modelled, never treated as a guaranteed Gmail snippet. */
  previewText: string;
  /** Subject this version was written with (Recommended sequence Versions A/B/C). Selecting the
   *  version selects this subject too. */
  subjectId?: Id;
  origin?: string;
}

export type ThreadMode = 'new' | 'continue';

export interface Step {
  id: Id;
  name: string;
  /** Days after the previous step (step 1: days after the sequence starts). */
  delayDays: number;
  delayIsDefault: boolean;
  threadMode: ThreadMode;
  /** Step whose thread this one continues; defaults to the previous step. */
  continueFromStepId?: Id;
  threadIsDefault: boolean;
  subjects: SubjectVariant[];
  selectedSubjectId?: Id;
  versions: Version[];
  selectedVersionId?: Id;
  includeSignature: boolean;
  /** When continuing a thread, quote the previous message below the body (Gmail hides it
   *  behind the ••• button). */
  quotePrevious: boolean;
  origin?: string;
}

export interface Sequence {
  id: Id;
  name: string;
  description: string;
  steps: Step[];
  blocks: Block[];
  origin?: string;
}

export interface Variable {
  name: string;
  fallback: string;
  description: string;
}

export interface Profile {
  id: Id;
  label: string;
  recipientName: string;
  recipientEmail: string;
  /** Sample values keyed by variable name. */
  values: Record<string, string>;
}

export interface Category {
  id: Id;
  name: string;
  description: string;
  addedByTool: boolean;
}

export interface Reply {
  id: Id;
  title: string;
  categoryId?: Id;
  categoryIsSuggested: boolean;
  /** Source section the reply came from (Reply Library, Payment, Rights & Confidentiality…). */
  group: string;
  body: string;
  /** Internal-only guidance. Never rendered in any recipient preview. */
  internalNote: string;
  origin?: string;
}

export type TurnRole = 'prospect' | 'us';

export interface Turn {
  id: Id;
  role: TurnRole;
  /** Prospect turns: the incoming message. Our turns: custom text when `custom` is true. */
  text: string;
  /** Our turns: the library reply sent. */
  replyId?: Id;
  custom: boolean;
  /** Fictional content created by the tool (the source has no incoming messages). */
  sample: boolean;
}

/** A reply branch: the prospect answers after `afterStepId`, then the turns alternate. */
export interface Conversation {
  id: Id;
  name: string;
  sequenceId: Id;
  afterStepId: Id;
  connectionIsSuggested: boolean;
  turns: Turn[];
}

export interface Settings {
  /** Stop the remaining automated steps once the prospect replies. */
  stopOnReply: boolean;
  /** Local date-time the first step is sent, "YYYY-MM-DDTHH:mm". */
  startAt: string;
  /** html = Markdown is rendered (links, bold, lists); plain = sent as typed. */
  bodyFormat: 'html' | 'plain';
  /** Hours between a message and the prospect's answer in reply previews. */
  replyAfterHours: number;
  /** Hours between the prospect's message and our answer. */
  answerAfterHours: number;
}

export interface Library {
  title: string;
  sender: Person;
  senderIsDefault: boolean;
  signature: string;
  signatureIsDefault: boolean;
  variables: Variable[];
  profiles: Profile[];
  activeProfileId: Id;
  categories: Category[];
  sequences: Sequence[];
  replies: Reply[];
  conversations: Conversation[];
  /** Library-level supporting content, in source order. */
  blocks: Block[];
  settings: Settings;
  sourceFileName: string;
}

/** Something the importer was unsure about; shown before an import is applied. */
export interface ImportNote {
  level: 'info' | 'ambiguous' | 'kept';
  section: string;
  message: string;
}

export interface ImportResult {
  format: 'studio' | 'source';
  library: Library;
  notes: ImportNote[];
}
