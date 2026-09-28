import { describe, expect, it } from "vitest";
import { CHALLENGE_PURPOSES, isChallengePurpose } from "./challenge-purposes";

describe("A-P2-RECOVERY 挑战用途唯一来源", () => {
  it("四种用途由同一 contracts 守卫识别", () => {
    expect(CHALLENGE_PURPOSES).toEqual(["login", "signup", "email_change", "recovery"]);
    for (const purpose of CHALLENGE_PURPOSES) expect(isChallengePurpose(purpose)).toBe(true);
    expect(isChallengePurpose("recovery_stop")).toBe(false);
  });
});
