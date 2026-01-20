"use client";

import MainLayout from "@/components/MainLayout";
import UniqueDomainsExtractor from "@/components/UniqueDomainsExtractor";
import ProtectedRoute from "@/components/ProtectedRoute";

export default function DomainsExtractorPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="relative flex-1 overflow-auto">
          <UniqueDomainsExtractor />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
