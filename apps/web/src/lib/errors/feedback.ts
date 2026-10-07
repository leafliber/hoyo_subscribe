// P2-07 获准跨卡接缝：recent_auth_required 改为所有危险操作共用的措辞。
// P2-05 获准跨卡接缝：F1-04 穷尽表补恢复码保存与最近认证原因。
import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorDetail,
  UnauthorizedReason,
} from "@hoyo/contracts";
import { isApiErrorBody } from "@hoyo/contracts";

/** 页面只根据合同里的 code/details 行动；服务端 message 不进入可见文案。 */
export interface ErrorFeedback {
  readonly title: string;
  readonly explanation: string;
  readonly nextStep: string;
  readonly action:
    | "correct_fields"
    | "complete_activation"
    | "login"
    | "refresh"
    | "compare"
    | "wait"
    | "use_other_capability"
    | "save_recovery_code"
    | "check_status"
    | "retry"
    | "confirm_result";
  readonly actionHref?: "/recover#save";
  readonly outcome: "failed" | "uncertain";
  readonly preserveInput: boolean;
  readonly automaticRetry: false;
  /** 错误反馈不得禁用、盖住或移除页面上的必要终止入口。 */
  readonly keepTerminationAccess: true;
  readonly firstInvalidField?: string;
}

type FeedbackCore = Pick<
  ErrorFeedback,
  "title" | "explanation" | "nextStep" | "action" | "actionHref"
>;

/** 新增 UnauthorizedReason 时，这张表必须补齐，否则 typecheck 失败。 */
export const UNAUTHORIZED_FEEDBACK: Readonly<Record<UnauthorizedReason, FeedbackCore>> = {
  origin_missing: {
    title: "无法确认请求来源",
    explanation: "这次操作未完成。当前页面的请求来源信息不完整。",
    nextStep: "请从本站页面重新打开该操作；若持续出现，请查看服务状态。",
    action: "refresh",
  },
  origin_mismatch: {
    title: "无法确认请求来源",
    explanation: "这次操作未完成。请求来源与当前站点不一致。",
    nextStep: "请回到本站页面重新操作。",
    action: "refresh",
  },
  csrf_missing: {
    title: "页面验证已失效",
    explanation: "这次操作未完成，输入内容仍可保留。",
    nextStep: "请刷新页面并确认内容后再提交。",
    action: "refresh",
  },
  csrf_mismatch: {
    title: "页面验证已失效",
    explanation: "这次操作未完成，输入内容仍可保留。",
    nextStep: "请刷新页面并确认内容后再提交。",
    action: "refresh",
  },
  no_session: {
    title: "需要登录",
    explanation: "这次操作未写入，当前草稿仍应保留在本账号下。",
    nextStep: "请重新登录后核对草稿，再决定是否提交。",
    action: "login",
  },
  session_expired: {
    title: "登录已过期",
    explanation: "这次操作未写入，当前草稿仍应保留在本账号下。",
    nextStep: "请重新登录后核对草稿，再决定是否提交。",
    action: "login",
  },
  pending_activation: {
    title: "还需完成激活",
    explanation: "当前会话尚未激活，这次写入未完成。",
    nextStep: "请完成激活后核对草稿，再继续操作。",
    action: "complete_activation",
  },
  recovery_code_unconfirmed: {
    title: "先保存新恢复码",
    explanation: "恢复会话的新码尚未完成保存确认，这次写入未执行。",
    nextStep: "去保存恢复码：请先生成、保存并确认新恢复码，再继续操作。",
    action: "save_recovery_code",
    actionHref: "/recover#save",
  },
  recent_auth_required: {
    title: "需要最近认证",
    explanation: "这次操作未执行，当前会话缺少有效的用途限定认证证明。",
    nextStep: "请完成本次操作要求的邮箱或恢复码验证后再试。",
    action: "login",
  },
  wrong_domain: {
    title: "当前会话不能执行此操作",
    explanation: "这次操作未完成，当前会话没有所需权限。",
    nextStep: "请使用有权限的会话，或返回公开浏览。",
    action: "login",
  },
};

const failed = (core: FeedbackCore, extra?: Partial<ErrorFeedback>): ErrorFeedback => ({
  ...core,
  outcome: "failed",
  preserveInput: true,
  automaticRetry: false,
  keepTerminationAccess: true,
  ...extra,
});

function waitText(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return "请稍后再试。";
  }
  return `服务端建议至少等待 ${Math.ceil(milliseconds / 1000)} 秒后再试。`;
}

/** 调用方可提供已知操作名称；不直接展示服务端自由文本或短码。 */
export interface FeedbackContext {
  readonly affectedOperation?: string;
}

type Mapping = (details: ApiErrorDetail | undefined, context: FeedbackContext) => ErrorFeedback;

/** 新增 ApiErrorCode 时，这张表必须补齐，否则 typecheck 失败。 */
export const API_ERROR_FEEDBACK: Readonly<Record<ApiErrorCode, Mapping>> = {
  validation: (details) => {
    const first =
      details?.code === "validation" && Array.isArray(details.fields)
        ? details.fields[0]?.path
        : undefined;
    return failed(
      {
        title: "请检查填写内容",
        explanation: "有字段需要修改，已填写内容会保留。",
        nextStep: "请查看字段旁的原因，并从第一个有误字段继续。",
        action: "correct_fields",
      },
      first === undefined ? undefined : { firstInvalidField: first },
    );
  },
  unauthorized: (details) => {
    const reason = details?.code === "unauthorized" ? details.reason : "no_session";
    // 运行时收到未识别的 reason 时仍按通用认证失败处理，不显示成功。
    return failed(UNAUTHORIZED_FEEDBACK[reason] ?? UNAUTHORIZED_FEEDBACK.no_session);
  },
  conflict: () =>
    failed({
      title: "云端内容已变化",
      explanation: "这次保存未完成；云端和本机草稿可能不同。",
      nextStep: "请重新读取云端内容，对比差异后手动决定如何保存。",
      action: "compare",
    }),
  rate_limited: (details) =>
    failed({
      title: "操作过于频繁",
      explanation: "这次操作未完成。重复点击不会加快处理。",
      nextStep: waitText(details?.code === "rate_limited" ? details.retry_after_ms : undefined),
      action: "wait",
    }),
  capacity_reached: (_details, context) =>
    failed({
      title: "当前能力暂无名额",
      explanation: `${context.affectedOperation ?? "这项能力"}目前无法启用；公开浏览和其他已启用能力不受此结果影响。`,
      nextStep: "请继续使用可用能力，稍后查看服务状态。",
      action: "use_other_capability",
    }),
  quota_paused: (_details, context) =>
    failed({
      title: "操作或通道额度已用尽",
      explanation: `${context.affectedOperation ?? "当前操作或通道"}暂不可用；这次操作未完成。`,
      nextStep: "请查看服务状态。停用服务的入口仍应保留；提交停用后也须确认实际结果。",
      action: "check_status",
    }),
  temporarily_unavailable: (details) =>
    failed({
      title: "服务暂不可用",
      explanation: "这次操作未完成；已有可用内容和草稿应保留。",
      nextStep: `请查看服务状态。${waitText(details?.code === "temporarily_unavailable" ? details.retry_after_ms : undefined)}仅在确认状态后手动重试。`,
      action: "retry",
    }),
};

export function feedbackForApiError(
  body: ApiErrorBody,
  context: FeedbackContext = {},
): ErrorFeedback {
  return API_ERROR_FEEDBACK[body.error.code](body.error.details, context);
}

export type TransportFailure = { readonly kind: "timeout" | "network" };

export function feedbackForFailure(value: unknown, context: FeedbackContext = {}): ErrorFeedback {
  if (isApiErrorBody(value)) return feedbackForApiError(value, context);
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "timeout") {
      return {
        title: "请求超时，结果尚不确定",
        explanation: "请求可能已经被服务端执行，也可能尚未完成；当前没有可确认的结果。",
        nextStep: "请重新读取当前状态或查看操作记录，确认结果后再决定是否重试。",
        action: "confirm_result",
        outcome: "uncertain",
        preserveInput: true,
        automaticRetry: false,
        keepTerminationAccess: true,
      };
    }
    if (value.kind === "network") {
      return {
        title: "网络中断，结果尚不确定",
        explanation: "当前无法确认请求是否完成。",
        nextStep: "恢复网络后先重新读取当前状态，再决定是否重试。",
        action: "confirm_result",
        outcome: "uncertain",
        preserveInput: true,
        automaticRetry: false,
        keepTerminationAccess: true,
      };
    }
  }
  return {
    title: "操作状态尚未确认",
    explanation: "当前未收到可确认的结果，不能将操作显示为成功。",
    nextStep: "请重新读取当前状态或查看服务状态后再决定下一步。",
    action: "confirm_result",
    outcome: "uncertain",
    preserveInput: true,
    automaticRetry: false,
    keepTerminationAccess: true,
  };
}
