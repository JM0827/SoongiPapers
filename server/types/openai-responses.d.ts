import type {
  ResponseFormatJSONObject,
  ResponseFormatJSONSchema,
  ResponseFormatText,
} from 'openai/resources/shared.js';

type ResponseFormatExtension =
  | ResponseFormatJSONSchema
  | ResponseFormatText
  | ResponseFormatJSONObject;

declare module 'openai/resources/responses' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}

declare module 'openai/resources/responses/index' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}

declare module 'openai/resources/responses/index.js' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}

declare module 'openai/resources/responses.js' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}

declare module 'openai/resources/responses/responses' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}

declare module 'openai/resources/responses/responses.js' {
  interface ResponseCreateParamsBase {
    response_format?: ResponseFormatExtension;
  }
}
