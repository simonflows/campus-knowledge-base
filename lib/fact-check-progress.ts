export type FactCheckProgress = {
  stage: "extract" | "verify";
  completed: number;
  total: number;
};
