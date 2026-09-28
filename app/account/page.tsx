'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import Toast from '@/components/ui/Toast';
import { UserCircle, Lock, LogOut, X, Shield, KeyRound } from 'lucide-react';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { OtpInput } from '@/components/ui/OtpInput';
import type { MfaFactor } from '@/contexts/AuthContext';

export default function AccountPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <AccountContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function AccountContent() {
  const {
    user,
    signOutAll,
    changePassword,
    mfaListFactors,
    mfaEnrollTotp,
    mfaChallengeAndVerify,
    mfaUnenroll,
  } = useAuth();
  const router = useRouter();

  // Account section state
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showLogoutAllConfirm, setShowLogoutAllConfirm] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);

  // Two-factor authentication (TOTP) state
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [loadingMfa, setLoadingMfa] = useState(true);
  const [showEnrollDialog, setShowEnrollDialog] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollFactor, setEnrollFactor] = useState<{ id: string; qrCode: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [verifyingMfa, setVerifyingMfa] = useState(false);
  const [showUnenrollConfirm, setShowUnenrollConfirm] = useState(false);
  const [unenrollingMfa, setUnenrollingMfa] = useState(false);

  const verifiedFactor = mfaFactors.find((f) => f.status === 'verified') ?? null;
  const mfaEnabled = !!verifiedFactor;

  const refreshMfaFactors = useCallback(async () => {
    setLoadingMfa(true);
    const { data, error } = await mfaListFactors();
    if (error) {
      setToastMessage(error.message || 'Failed to load two-factor settings.');
      setShowToast(true);
      setLoadingMfa(false);
      return;
    }
    setMfaFactors(data?.totp ?? []);
    setLoadingMfa(false);
  }, [mfaListFactors]);

  useEffect(() => {
    if (!user) return;
    refreshMfaFactors();
  }, [user, refreshMfaFactors]);

  const handleStartEnroll = async () => {
    setEnrolling(true);
    setMfaCode('');
    setMfaError('');

    // A stale unverified factor (abandoned setup) would block a fresh enrol
    // with the same name, so clear it first.
    const existingUnverified = mfaFactors.find((f) => f.status === 'unverified');
    if (existingUnverified) {
      await mfaUnenroll(existingUnverified.id);
    }

    const { data, error } = await mfaEnrollTotp('Authenticator app');
    setEnrolling(false);
    if (error || !data) {
      setToastMessage(error?.message || 'Failed to start two-factor setup.');
      setShowToast(true);
      return;
    }
    setEnrollFactor({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setShowEnrollDialog(true);
  };

  const handleVerifyEnroll = async (otp?: string) => {
    if (!enrollFactor) return;
    const code = (otp ?? mfaCode).trim();
    if (code.length !== 6) {
      setMfaError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setMfaError('');
    setVerifyingMfa(true);
    const { error } = await mfaChallengeAndVerify(enrollFactor.id, code);
    setVerifyingMfa(false);
    if (error) {
      setMfaCode('');
      setMfaError(error.message || 'Invalid code. Please try again.');
      return;
    }
    setShowEnrollDialog(false);
    setEnrollFactor(null);
    setMfaCode('');
    setToastMessage('Two-factor authentication enabled.');
    setShowToast(true);
    await refreshMfaFactors();
  };

  const handleCancelEnroll = async () => {
    if (verifyingMfa) return;
    const pending = enrollFactor;
    setShowEnrollDialog(false);
    setEnrollFactor(null);
    setMfaCode('');
    setMfaError('');
    if (pending) {
      // Best-effort cleanup of the unverified factor we just created.
      await mfaUnenroll(pending.id).catch(() => {});
      await refreshMfaFactors();
    }
  };

  const handleUnenroll = async () => {
    if (!verifiedFactor) return;
    setUnenrollingMfa(true);
    const { error } = await mfaUnenroll(verifiedFactor.id);
    setUnenrollingMfa(false);
    setShowUnenrollConfirm(false);
    if (error) {
      setToastMessage(error.message || 'Failed to disable two-factor authentication.');
      setShowToast(true);
      return;
    }
    setToastMessage('Two-factor authentication disabled.');
    setShowToast(true);
    await refreshMfaFactors();
  };

  const handleSignOutAll = () => setShowLogoutAllConfirm(true);

  const confirmSignOutAll = async () => {
    try {
      await signOutAll();
      router.push('/login');
    } catch (error) {
      console.error('Error signing out from all devices:', error);
      setToastMessage('Failed to sign out from all devices. Please try again.');
      setShowToast(true);
      setShowLogoutAllConfirm(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError('');
    if (!newPassword || !confirmPassword) {
      setPasswordError('Please fill in all fields');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters long');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    setIsChangingPassword(true);
    try {
      await changePassword(newPassword);
      setShowChangePasswordDialog(false);
      setNewPassword('');
      setConfirmPassword('');
      setToastMessage('Password changed successfully!');
      setShowToast(true);
    } catch (error) {
      console.error('Error changing password:', error);
      setPasswordError(error instanceof Error ? error.message : 'Failed to change password. Please try again.');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const closeChangePasswordDialog = () => {
    setShowChangePasswordDialog(false);
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError('');
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <UserCircle className="w-6 h-6 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account & Security</h1>
          <p className="text-sm text-gray-500">Manage your password, two-factor authentication and sessions</p>
        </div>
      </div>

      {/* Account section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Account</h2>
        <div className="space-y-4">
          <div className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50/50 transition-colors">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <KeyRound className="w-5 h-5 text-emerald-600" />
                <div>
                  <h3 className="font-medium text-gray-900 flex items-center gap-2">
                    Two-Factor Authentication
                    {!loadingMfa && mfaEnabled && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                        Enabled
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-gray-500">
                    {mfaEnabled
                      ? 'An authenticator app is configured. A 6-digit code is required at every sign in.'
                      : 'Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password) at sign in.'}
                  </p>
                </div>
              </div>
              {loadingMfa ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-400 shrink-0" />
              ) : mfaEnabled ? (
                <button
                  onClick={() => setShowUnenrollConfirm(true)}
                  className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors shrink-0"
                >
                  Disable
                </button>
              ) : (
                <button
                  onClick={handleStartEnroll}
                  disabled={enrolling}
                  className="px-4 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {enrolling ? 'Preparing...' : 'Enable'}
                </button>
              )}
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Lock className="w-5 h-5 text-blue-600" />
                <div>
                  <h3 className="font-medium text-gray-900">Change Password</h3>
                  <p className="text-sm text-gray-500">Update your password to keep your account secure.</p>
                </div>
              </div>
              <button
                onClick={() => setShowChangePasswordDialog(true)}
                className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
              >
                Change Password
              </button>
            </div>
          </div>

          <div className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <LogOut className="w-5 h-5 text-orange-600" />
                <div>
                  <h3 className="font-medium text-gray-900">Logout All</h3>
                  <p className="text-sm text-gray-500">Sign out from all devices and end all active sessions.</p>
                </div>
              </div>
              <button
                onClick={handleSignOutAll}
                className="px-4 py-2 text-sm font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors"
              >
                Logout All
              </button>
            </div>
          </div>
        </div>
      </section>

      <DeleteConfirmationModal
        isOpen={showUnenrollConfirm}
        title="Disable Two-Factor Authentication?"
        message="Removing your authenticator app will weaken account security. You can enable it again at any time."
        onConfirm={handleUnenroll}
        onCancel={() => {
          if (!unenrollingMfa) setShowUnenrollConfirm(false);
        }}
        confirmText={unenrollingMfa ? 'Disabling...' : 'Disable'}
        cancelText="Cancel"
        confirmDisabled={unenrollingMfa}
      />

      {showEnrollDialog && enrollFactor && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-emerald-600" />
                Set up Two-Factor Authentication
              </h2>
              <button
                onClick={handleCancelEnroll}
                disabled={verifyingMfa}
                className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600">
              Scan the QR code with your authenticator app, then enter the 6-digit code it generates.
            </p>

            <div className="flex justify-center rounded-lg border border-gray-200 bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns an SVG data URI */}
              <img src={enrollFactor.qrCode} alt="Two-factor authentication QR code" className="h-48 w-48 object-contain" />
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Or enter this secret manually</p>
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 break-all select-all">
                {enrollFactor.secret}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Verification code</label>
              <div className="flex justify-center">
                <OtpInput
                  value={mfaCode}
                  onChange={(v) => {
                    setMfaCode(v);
                    if (mfaError) setMfaError('');
                  }}
                  onComplete={(v) => {
                    if (!verifyingMfa) handleVerifyEnroll(v);
                  }}
                  disabled={verifyingMfa}
                  autoFocus
                />
              </div>
            </div>

            {mfaError && (
              <div className="text-sm text-red-600 bg-red-50 p-2 rounded-lg">{mfaError}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => handleVerifyEnroll()}
                disabled={verifyingMfa || mfaCode.length !== 6}
                className="flex-1 bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {verifyingMfa ? 'Verifying...' : 'Verify & Enable'}
              </button>
              <button
                onClick={handleCancelEnroll}
                disabled={verifyingMfa}
                className="flex-1 bg-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmationModal
        isOpen={showLogoutAllConfirm}
        title="Logout All Devices"
        message="Are you sure you want to log out from all devices? This will end all active sessions."
        onConfirm={confirmSignOutAll}
        onCancel={() => setShowLogoutAllConfirm(false)}
        confirmText="Logout All"
        cancelText="Cancel"
      />

      {showChangePasswordDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                Change Password
              </h2>
              <button
                onClick={closeChangePasswordDialog}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <PasswordInput
                  id="newPassword"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter new password"
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm Password
                </label>
                <PasswordInput
                  id="confirmPassword"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Confirm new password"
                />
              </div>

              {passwordError && (
                <div className="text-sm text-red-600 bg-red-50 p-2 rounded-lg">
                  {passwordError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleChangePassword}
                  disabled={isChangingPassword}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isChangingPassword ? 'Changing...' : 'Change Password'}
                </button>
                <button
                  onClick={closeChangePasswordDialog}
                  disabled={isChangingPassword}
                  className="flex-1 bg-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Toast
        message={toastMessage}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
        duration={4000}
      />
    </div>
  );
}