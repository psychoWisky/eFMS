"use client";
import { use } from "react";
import { FocSheetView } from "@/modules/foc/foc-sheet-view";

export default function FocSheetRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <FocSheetView sheetId={id} />;
}
