import CompanyResearcher from "../components/CompanyResearchHome";
import ProtectedRoute from "../components/ProtectedRoute";
import MainLayout from "../components/MainLayout";

export default function Home() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="relative flex-grow flex flex-col items-center justify-center">
          {/* background grid design texture code */}
          <div className="absolute inset-0 -z-0 w-full h-full bg-[linear-gradient(to_right,#80808012_1px,transparent_0px),linear-gradient(to_bottom,#80808012_1px,transparent_0px)] bg-[size:60px_60px]"></div>
          <CompanyResearcher />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}