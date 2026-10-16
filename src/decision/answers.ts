export interface DecisionAnswer {
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecisionAnswers {
  [question: string]: DecisionAnswer;
}
