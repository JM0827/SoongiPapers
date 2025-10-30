export const chatActionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: [
        'startTranslation',
        'startUploadFile',
        'viewTranslationStatus',
        'cancelTranslation',
        'startProofread',
        'startQuality',
        'viewQualityReport',
        'openExportPanel',
        'viewTranslatedText',
        'openProofreadTab',
        'describeProofSummary',
        'acknowledge',
        'createProject',
        'applyEditingSuggestion',
        'undoEditingSuggestion',
        'dismissEditingSuggestion',
      ],
    },
    label: { type: ['string', 'null'], maxLength: 120 },
    reason: { type: ['string', 'null'], maxLength: 320 },
    allowParallel: { type: 'boolean' },
    autoStart: { type: 'boolean' },
    jobId: { type: ['string', 'null'], maxLength: 64 },
    workflowRunId: { type: ['string', 'null'], maxLength: 64 },
    suggestionId: { type: ['string', 'null'], maxLength: 64 },
  },
  required: [
    'type',
    'label',
    'reason',
    'allowParallel',
    'autoStart',
    'jobId',
    'workflowRunId',
    'suggestionId',
  ],
} as const;

export const chatReplySchema = {
  name: 'chat_reply_payload_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', minLength: 1, maxLength: 4_096 },
      actions: {
        type: 'array',
        items: chatActionSchema,
        maxItems: 8,
        default: [],
      },
      profileUpdates: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: ['string', 'null'], maxLength: 160 },
          author: { type: ['string', 'null'], maxLength: 160 },
          context: { type: ['string', 'null'], maxLength: 480 },
          translationDirection: {
            type: ['string', 'null'],
            maxLength: 120,
          },
          memo: { type: ['string', 'null'], maxLength: 640 },
        },
        required: [
          'title',
          'author',
          'context',
          'translationDirection',
          'memo',
        ],
      },
      actionsNote: { type: ['string', 'null'], maxLength: 320 },
    },
    required: ['reply', 'actions', 'profileUpdates', 'actionsNote'],
  },
} as const;

export const intentClassifierSchema = {
  name: 'chat_intent_payload_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        enum: [
          'translate',
          'proofread',
          'quality',
          'status',
          'cancel',
          'upload',
          'ebook',
          'other',
        ],
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      rerun: { type: 'boolean' },
      label: { type: ['string', 'null'], maxLength: 120 },
      notes: { type: ['string', 'null'], maxLength: 200 },
    },
    required: ['intent', 'confidence', 'rerun', 'label', 'notes'],
  },
} as const;

export const entityExtractionSchema = {
  name: 'chat_entity_payload_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: ['string', 'null'], maxLength: 160 },
      author: { type: ['string', 'null'], maxLength: 160 },
      context: { type: ['string', 'null'], maxLength: 480 },
      translationDirection: { type: ['string', 'null'], maxLength: 120 },
      memo: { type: ['string', 'null'], maxLength: 640 },
    },
    required: ['title', 'author', 'context', 'translationDirection', 'memo'],
  },
} as const;

export const editingAssistantSchema = {
  name: 'chat_editing_payload_v1',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      updatedText: { type: 'string', minLength: 1 },
      explanation: { type: ['string', 'null'], maxLength: 640 },
      warnings: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 200 },
        maxItems: 6,
        default: [],
      },
    },
    required: ['updatedText', 'explanation', 'warnings'],
  },
} as const;
