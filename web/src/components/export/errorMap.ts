export type BackendErrorCode =
  | "file_missing"
  | "translation_missing"
  | "rights_missing"
  | "validation_failed"
  | "cover_generation_pending"
  | "summary_unavailable"
  | "rate_limited"
  | "unauthorized"
  | "unknown_error"
  | string;

type FriendlyError = {
  title: string;
  message: string;
};

export const mapGenerationError = (code?: BackendErrorCode): FriendlyError => {
  switch (code) {
    case "file_missing":
    case "translation_missing":
      return {
        title: "번역본 없음",
        message: "전자책으로 내보낼 번역본을 선택하거나 생성해 주세요.",
      };
    case "rights_missing":
      return {
        title: "저작권 동의 필요",
        message: "전자책 생성을 위해 역자 동의가 필요합니다.",
      };
    case "validation_failed":
      return {
        title: "입력값 확인 필요",
        message: "제목, 원작자, 번역가 등 필수 정보를 확인해 주세요.",
      };
    case "cover_generation_pending":
      return {
        title: "표지 생성 중",
        message: "표지 작업이 완료되면 자동으로 반영됩니다.",
      };
    case "summary_unavailable":
      return {
        title: "요약 준비 중",
        message: "요약 정보를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
      };
    case "rate_limited":
      return {
        title: "요청 한도 초과",
        message: "잠시 후 다시 시도해 주세요.",
      };
    case "unauthorized":
      return {
        title: "권한 없음",
        message: "세션을 확인하거나 다시 로그인해 주세요.",
      };
    case "unknown_error":
    default:
      return {
        title: "오류",
        message: "알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      };
  }
};
