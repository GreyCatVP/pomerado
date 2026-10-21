/**
 * The minter's instruction for `rehearsal_failed`: a host ran the repaired tool once with the
 * original call's input, set to stop just before its first save request reached the site, and it
 * failed before it got there. The refusal's `rehearsal` names the error and the source line beside
 * it.
 */
export const rehearsalFailedInstruction =
  "Not published: the host ran the repaired tool once on the live site with the original call's input, set to stop just before its first save request reaches the site, and the tool failed before it got that far. rehearsal names the error and the source line it came from. Fix the source so the tool gets to its first save on this input, then call finish_build again with the same executionId; the host runs it again the same way. Never run the write yourself for this.";
