export const DecisionQuestionType = {
  Noul: "noul",
  Boolean: "boolean",
  Choice: "choice",
  Score: "score",
  Numeric: "numeric",
} as const;

export type DecisionQuestionType =
  (typeof DecisionQuestionType)[keyof typeof DecisionQuestionType];

export const DECISION_QUESTION_TYPES: readonly DecisionQuestionType[] =
  Object.values(DecisionQuestionType);

export function isDecisionQuestionType(value: unknown): value is DecisionQuestionType {
  return (
    typeof value === "string" &&
    DECISION_QUESTION_TYPES.includes(value as DecisionQuestionType)
  );
}

export interface DecisionQuestion {
  type: DecisionQuestionType;
  instructions: string;
  criteria?: Record<string, string | null> | string[];
  options?: { id: string; description?: string }[];
  anchors?: { value: number; description: string }[];
  unit?: string;
}

export type Questionnaire = Record<string, DecisionQuestion>;
