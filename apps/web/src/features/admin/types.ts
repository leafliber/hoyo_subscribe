// P3-10 的传输形状；proposal_json 保持 unknown，候选规则只由服务端校验。
export interface CandidateDetail {
  candidate: {
    id: string;
    article_version_id: string;
    updated_at: number;
    review_status: string;
    proposal_json: unknown;
  };
  article: {
    articleVersionId: string;
    articleId: string;
    sourceId: string;
    externalId: string;
    officialUrl: string;
    completeness: string;
    blocks: ({ kind: "html"; html: string } | { kind: "title" | "text"; text: string })[];
  };
  evidence: Record<string, unknown>[];
}

export interface QueuePage {
  candidates: { id: string; created_at: number; updated_at: number }[];
  next_cursor: string | null;
}

export type ReviewAction = "revise" | "reject" | "approve" | "correct" | "associate" | "retract";

export interface PublicationReply {
  candidate_id: string;
  review_status: string;
  updated_at: number;
  publication: { outcome: string };
}
