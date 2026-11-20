export interface DiceDerivationDomain {
  readonly drandRandomness: string;
  readonly drandRound: number;
  readonly drandChainHash: string;
  readonly gameId: string;
  readonly cashQuoteId: string | null;
  readonly playerWhite: string;
  readonly playerBlack: string;
  readonly roller: "white" | "black";
  readonly turnNumber: number;
  readonly rulesVersion: string;
  readonly openingRoll: boolean;
}

export function canonicalDiceDerivationInput(input: DiceDerivationDomain, counter: number): string {
  return JSON.stringify({
    cashQuoteId: input.cashQuoteId,
    counter,
    drandChainHash: input.drandChainHash,
    drandRandomness: input.drandRandomness,
    drandRound: input.drandRound,
    gameId: input.gameId,
    openingRoll: input.openingRoll,
    playerBlack: input.playerBlack,
    playerWhite: input.playerWhite,
    roller: input.roller,
    rulesVersion: input.rulesVersion,
    turnNumber: input.turnNumber,
    type: "gammon.dice-result.v2",
  });
}

export function canonicalDiceCommitmentInput(
  input: Omit<DiceDerivationDomain, "drandRandomness">,
): string {
  return JSON.stringify({
    cashQuoteId: input.cashQuoteId,
    drandChainHash: input.drandChainHash,
    drandRound: input.drandRound,
    gameId: input.gameId,
    openingRoll: input.openingRoll,
    playerBlack: input.playerBlack,
    playerWhite: input.playerWhite,
    roller: input.roller,
    rulesVersion: input.rulesVersion,
    turnNumber: input.turnNumber,
    type: "gammon.dice-commitment.v2",
  });
}
