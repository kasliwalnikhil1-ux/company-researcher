"use client";

import MainLayout from "@/components/MainLayout";
import CsvEnrich from "@/components/CsvEnrich";
import ProtectedRoute from "@/components/ProtectedRoute";

export default function EnrichPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="relative flex-1 overflow-auto">
          <CsvEnrich />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
