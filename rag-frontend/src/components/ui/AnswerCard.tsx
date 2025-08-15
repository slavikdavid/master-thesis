// src/components/AnswerCard.tsx
import { Card, CardContent } from "../ui/card";

type Props = {
  answer: string;
};

export function AnswerCard({ answer }: Props) {
  if (!answer) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <p className="font-semibold">Answer:</p>
        <pre className="whitespace-pre-wrap">{answer}</pre>
      </CardContent>
    </Card>
  );
}
