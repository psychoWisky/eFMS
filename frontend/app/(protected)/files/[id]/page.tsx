"use client";
import { NotesheetPage } from "@/modules/files/notesheet-editor";
import { use } from "react";

export default function FileRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <NotesheetPage fileId={id} />;
}
