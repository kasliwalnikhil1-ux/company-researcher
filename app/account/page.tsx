'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useOwner, OWNER_COLOR_PRESETS, OWNER_PRESET_LABELS, type OwnerConfigItem } from '@/contexts/OwnerContext';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import Toast from '@/components/ui/Toast';
import { UserCircle, Lock, LogOut, X, Shield, Plus, Pencil, Trash2, Check, Mail, Twitter, UserX } from 'lucide-react';
import type { EmailSettings } from '@/lib/emailCompose';
import { normalizeExcludeDomain, normalizeExcludeLinkedinUrl } from '@/lib/utils';

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
  const { user, signOutAll, changePassword } = useAuth();
  const { mergeOnboardingLocal } = useOnboarding();
  const { refetchOwners, selectedOwner, setSelectedOwner } = useOwner();
  const router = useRouter();

  // Account section state
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showLogoutAllConfirm, setShowLogoutAllConfirm] = useState(false);

  // Owners section state
  const [owners, setOwners] = useState<OwnerConfigItem[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColorIndex, setEditColorIndex] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColorIndex, setNewColorIndex] = useState(0);

  // Email settings state
  const [emailProvider, setEmailProvider] = useState<'gmail' | 'outlook'>('gmail');
  const [emailSaving, setEmailSaving] = useState(false);

  // Twitter personalization (stored in onboarding)
  const [allowPinnedTweetsOlderThanMax, setAllowPinnedTweetsOlderThanMax] = useState(true);
  const [maxTweetAgeDays, setMaxTweetAgeDays] = useState(7);
  const [twitterSaving, setTwitterSaving] = useState(false);

  // Exclude investors (stored in onboarding) — arrays for tag UI
  const [excludeDomains, setExcludeDomains] = useState<string[]>([]);
  const [excludeLinkedinUrls, setExcludeLinkedinUrls] = useState<string[]>([]);
  const [excludeDomainInput, setExcludeDomainInput] = useState('');
  const [excludeLinkedinInput, setExcludeLinkedinInput] = useState('');
  const [excludeSaving, setExcludeSaving] = useState(false);

  const showExcludeReminderToast = () => {
    setToastMessage('Click the button Save exclude list to save your changes.');
    setShowToast(true);
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

  const loadOwners = useCallback(async () => {
    if (!user?.id) {
      setOwnersLoading(false);
      return;
    }
    try {
      setOwnersLoading(true);
      const { data, error } = await supabase
        .from('user_settings')
        .select('owners, email_settings, onboarding')
        .eq('id', user.id)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching owners:', error);
        setOwners([]);
        return;
      }

      let list: OwnerConfigItem[] = [];
      if (data?.owners) {
        const raw = typeof data.owners === 'string' ? JSON.parse(data.owners) : data.owners;
        if (Array.isArray(raw)) {
          list = raw.filter(
            (x: unknown): x is OwnerConfigItem =>
              typeof x === 'object' &&
              x !== null &&
              typeof (x as OwnerConfigItem).name === 'string' &&
              typeof (x as OwnerConfigItem).colors === 'object'
          );
        }
      }
      setOwners(list);

      const es = data?.email_settings;
      if (es && typeof es === 'object') {
        const parsed = typeof es === 'string' ? JSON.parse(es) : es;
        if (parsed && (parsed.provider === 'gmail' || parsed.provider === 'outlook')) {
          setEmailProvider(parsed.provider);
        }
      }

      const ob = data?.onboarding;
      if (ob && typeof ob === 'object') {
        const parsed = typeof ob === 'string' ? JSON.parse(ob) : ob;
        const tp = parsed?.twitterPersonalization;
        if (tp && typeof tp === 'object') {
          if (typeof tp.allowPinnedTweetsOlderThanMax === 'boolean') {
            setAllowPinnedTweetsOlderThanMax(tp.allowPinnedTweetsOlderThanMax);
          }
          if (typeof tp.maxTweetAgeDays === 'number' && tp.maxTweetAgeDays >= 1) {
            setMaxTweetAgeDays(tp.maxTweetAgeDays);
          }
        }
        const ei = parsed?.excludeInvestors;
        if (ei && typeof ei === 'object') {
          if (Array.isArray(ei.domains)) {
            setExcludeDomains(ei.domains.filter((d: unknown): d is string => typeof d === 'string'));
          }
          if (Array.isArray(ei.linkedinUrls)) {
            setExcludeLinkedinUrls(ei.linkedinUrls.filter((u: unknown): u is string => typeof u === 'string'));
          }
        }
      }
    } finally {
      setOwnersLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadOwners();
  }, [loadOwners]);

  const saveOwners = async (newOwners: OwnerConfigItem[]) => {
    if (!user?.id) return;
    try {
      setSaving(true);
      const { data: existing } = await supabase
        .from('user_settings')
        .select('personalization, owners, email_settings, onboarding, column_settings')
        .eq('id', user.id)
        .single();

      const payload = {
        id: user.id,
        personalization: existing?.personalization ?? null,
        owners: newOwners,
        email_settings: existing?.email_settings ?? null,
        onboarding: existing?.onboarding ?? null,
        column_settings: existing?.column_settings ?? null,
      };

      const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });

      if (error) throw error;
      setOwners(newOwners);
      await refetchOwners();
      setToastMessage('Owners saved successfully.');
      setShowToast(true);
      setEditingId(null);
      setIsAdding(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to save owners';
      setToastMessage(`Error: ${msg}`);
      setShowToast(true);
    } finally {
      setSaving(false);
    }
  };

  const handleAddOwner = () => {
    if (!newName.trim()) {
      setToastMessage('Enter an owner name.');
      setShowToast(true);
      return;
    }
    const trimmed = newName.trim();
    if (owners.some((o) => o.name.toLowerCase() === trimmed.toLowerCase())) {
      setToastMessage('An owner with this name already exists.');
      setShowToast(true);
      return;
    }
    const colors = OWNER_COLOR_PRESETS[newColorIndex] ?? OWNER_COLOR_PRESETS[0];
    saveOwners([...owners, { name: trimmed, colors }]);
    setNewName('');
    setNewColorIndex(0);
  };

  const handleUpdateOwner = (index: number) => {
    const item = owners[index];
    if (!item) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      setToastMessage('Owner name cannot be empty.');
      setShowToast(true);
      return;
    }
    const conflict = owners.some(
      (o, i) => i !== index && o.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (conflict) {
      setToastMessage('Another owner already has this name.');
      setShowToast(true);
      return;
    }
    const colors = OWNER_COLOR_PRESETS[editColorIndex] ?? item.colors;
    const next = [...owners];
    next[index] = { name: trimmed, colors };
    saveOwners(next);
    setEditingId(null);
  };

  const handleDeleteOwner = (index: number) => {
    if (!confirm('Remove this owner? Companies using them will keep the value, but it will no longer appear in the sidebar list.')) return;
    const next = owners.filter((_, i) => i !== index);
    saveOwners(next);
  };

  const startEditOwner = (index: number) => {
    const item = owners[index];
    if (!item) return;
    const idx = OWNER_COLOR_PRESETS.findIndex((p) => p.hex === item.colors?.hex);
    setEditingId(`edit-${index}`);
    setEditName(item.name);
    setEditColorIndex(idx >= 0 ? idx : 0);
  };

  const cancelEditOwner = () => {
    setEditingId(null);
    setIsAdding(false);
    setNewName('');
  };

  const saveEmailSettings = async () => {
    if (!user?.id) return;
    try {
      setEmailSaving(true);
      const { data: existing } = await supabase
        .from('user_settings')
        .select('personalization, owners, onboarding, column_settings')
        .eq('id', user.id)
        .single();

      const email_settings: EmailSettings = {
        provider: emailProvider,
      };

      const payload = {
        id: user.id,
        personalization: existing?.personalization ?? null,
        owners: existing?.owners ?? [],
        email_settings,
        onboarding: existing?.onboarding ?? null,
        column_settings: existing?.column_settings ?? null,
      };

      const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      setToastMessage('Email settings saved.');
      setShowToast(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to save email settings';
      setToastMessage(`Error: ${msg}`);
      setShowToast(true);
    } finally {
      setEmailSaving(false);
    }
  };

  const saveTwitterPersonalization = async () => {
    if (!user?.id) return;
    try {
      setTwitterSaving(true);
      const { data: existing } = await supabase
        .from('user_settings')
        .select('personalization, owners, email_settings, onboarding, column_settings')
        .eq('id', user.id)
        .single();

      const existingOnboarding = existing?.onboarding;
      const ob = existingOnboarding && typeof existingOnboarding === 'object'
        ? (typeof existingOnboarding === 'string' ? JSON.parse(existingOnboarding) : existingOnboarding)
        : {};
      const updatedOnboarding = {
        ...ob,
        twitterPersonalization: {
          allowPinnedTweetsOlderThanMax: allowPinnedTweetsOlderThanMax,
          maxTweetAgeDays: maxTweetAgeDays,
        },
      };

      const payload = {
        id: user.id,
        personalization: existing?.personalization ?? null,
        owners: existing?.owners ?? null,
        email_settings: existing?.email_settings ?? null,
        onboarding: updatedOnboarding,
        column_settings: existing?.column_settings ?? null,
      };

      const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      mergeOnboardingLocal({
        twitterPersonalization: {
          allowPinnedTweetsOlderThanMax,
          maxTweetAgeDays,
        },
      });
      setToastMessage('Twitter personalization settings saved.');
      setShowToast(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to save Twitter settings';
      setToastMessage(`Error: ${msg}`);
      setShowToast(true);
    } finally {
      setTwitterSaving(false);
    }
  };

  const saveExcludeInvestors = async () => {
    if (!user?.id) return;
    try {
      setExcludeSaving(true);
      const { data: existing } = await supabase
        .from('user_settings')
        .select('personalization, owners, email_settings, onboarding, column_settings')
        .eq('id', user.id)
        .single();

      const domains = excludeDomains.map(normalizeExcludeDomain).filter((d): d is string => d != null);
      const linkedinUrls = excludeLinkedinUrls.map(normalizeExcludeLinkedinUrl).filter((u): u is string => u != null);

      const existingOnboarding = existing?.onboarding;
      const ob = existingOnboarding && typeof existingOnboarding === 'object'
        ? (typeof existingOnboarding === 'string' ? JSON.parse(existingOnboarding) : existingOnboarding)
        : {};
      const updatedOnboarding = {
        ...ob,
        excludeInvestors: {
          domains: [...new Set(domains)],
          linkedinUrls: [...new Set(linkedinUrls)],
        },
      };

      const payload = {
        id: user.id,
        personalization: existing?.personalization ?? null,
        owners: existing?.owners ?? null,
        email_settings: existing?.email_settings ?? null,
        onboarding: updatedOnboarding,
        column_settings: existing?.column_settings ?? null,
      };

      const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      mergeOnboardingLocal({
        excludeInvestors: {
          domains: [...new Set(domains)],
          linkedinUrls: [...new Set(linkedinUrls)],
        },
      });
      setToastMessage('Exclude investors saved.');
      setShowToast(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to save exclude list';
      setToastMessage(`Error: ${msg}`);
      setShowToast(true);
    } finally {
      setExcludeSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <UserCircle className="w-6 h-6 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account & Security</h1>
          <p className="text-sm text-gray-500">Manage your account, password, and owners</p>
        </div>
      </div>

      {/* Emails section */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Emails</h2>
        <p className="text-sm text-gray-500 mb-4">
          Choose your email provider for compose links on the companies page and in contact cards.
        </p>
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Provider</label>
              <select
                value={emailProvider}
                onChange={(e) => setEmailProvider(e.target.value as 'gmail' | 'outlook')}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook</option>
              </select>
            </div>
            <button
              type="button"
              onClick={saveEmailSettings}
              disabled={emailSaving}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              <Mail className="w-4 h-4" />
              {emailSaving ? 'Saving...' : 'Save email settings'}
            </button>
          </div>
        </div>
      </section>

      {/* Twitter Personalization section */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Twitter Personalization</h2>
        <p className="text-sm text-gray-500 mb-4">
          Control which tweets are used for investor outreach icebreakers. Timeline tweets older than the max age are ignored.
        </p>
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                id="allowPinnedOlder"
                type="checkbox"
                checked={allowPinnedTweetsOlderThanMax}
                onChange={(e) => setAllowPinnedTweetsOlderThanMax(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <label htmlFor="allowPinnedOlder" className="text-sm font-medium text-gray-700">
                Allow pinned tweets older than max age
              </label>
            </div>
            <p className="text-xs text-gray-500 ml-7">
              When on, the pinned tweet is always included for personalization even if it is older than the max age below.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Max tweet age</label>
              <select
                value={maxTweetAgeDays}
                onChange={(e) => setMaxTweetAgeDays(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value={1}>1 day</option>
                <option value={3}>3 days</option>
                <option value={7}>1 week</option>
                <option value={14}>2 weeks</option>
                <option value={30}>1 month</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Timeline tweets older than this are not used.</p>
            </div>
            <button
              type="button"
              onClick={saveTwitterPersonalization}
              disabled={twitterSaving}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              <Twitter className="w-4 h-4" />
              {twitterSaving ? 'Saving...' : 'Save Twitter settings'}
            </button>
          </div>
        </div>
      </section>

      {/* Exclude investors section */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Exclude investors</h2>
        <p className="text-sm text-gray-500 mb-4">
          Exclude specific firms (by domain) or individuals (by LinkedIn URL) from investor search. Add entries below; you can paste multiple separated by commas or new lines.
        </p>
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm space-y-6">
          {/* Firm domains */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Exclude firm domains</label>
            <p className="text-xs text-gray-500 mb-2">Firms with these domains will not appear in search.</p>
            {(excludeDomains.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {excludeDomains.map((d) => (
                <span
                  key={d}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm bg-gray-100 text-gray-800 border border-gray-200"
                >
                  {d}
                  <button
                    type="button"
                    onClick={() => {
                      setExcludeDomains((prev) => prev.filter((x) => x !== d));
                      showExcludeReminderToast();
                    }}
                    className="p-0.5 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-400"
                    aria-label={`Remove ${d}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
            )) || null}
            <div className="flex gap-2">
              <input
                type="text"
                value={excludeDomainInput}
                onChange={(e) => setExcludeDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const raw = (e.target as HTMLInputElement).value.trim();
                    if (!raw) return;
                    const parts = raw.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                    const normalized = parts.map(normalizeExcludeDomain).filter((d): d is string => d != null);
                    setExcludeDomains((prev) => [...new Set([...prev, ...normalized])]);
                    setExcludeDomainInput('');
                    showExcludeReminderToast();
                  }
                }}
                onPaste={(e) => {   
                  const pasted = e.clipboardData.getData('text').trim();
                  if (pasted && /[\n,]/.test(pasted)) {
                    e.preventDefault();
                    const parts = pasted.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                    const normalized = parts.map(normalizeExcludeDomain).filter((d): d is string => d != null);
                    setExcludeDomains((prev) => [...new Set([...prev, ...normalized])]);
                    showExcludeReminderToast();
                  }
                }}
                placeholder="e.g. a16z.com, sequoiacap.com"
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => {
                  const raw = excludeDomainInput.trim();
                  if (!raw) return;
                  const parts = raw.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                  const normalized = parts.map(normalizeExcludeDomain).filter((d): d is string => d != null);
                  setExcludeDomains((prev) => [...new Set([...prev, ...normalized])]);
                  setExcludeDomainInput('');
                  showExcludeReminderToast();
                }}
                className="px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-md border border-indigo-200 whitespace-nowrap"
              >
                Add
              </button>
            </div>
          </div>

          {/* LinkedIn URLs (individuals) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Exclude LinkedIn (individuals)</label>
            <p className="text-xs text-gray-500 mb-2">Use path (e.g. /in/username) or full URL. These people will not appear in search.</p>
            {(excludeLinkedinUrls.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {excludeLinkedinUrls.map((u) => (
                <span
                  key={u}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm bg-gray-100 text-gray-800 border border-gray-200 max-w-full truncate"
                  title={u}
                >
                  <span className="truncate">{u}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setExcludeLinkedinUrls((prev) => prev.filter((x) => x !== u));
                      showExcludeReminderToast();
                    }}
                    className="p-0.5 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700 flex-shrink-0 focus:outline-none focus:ring-1 focus:ring-gray-400"
                    aria-label={`Remove ${u}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
            )) || null}
            <div className="flex gap-2">
              <input
                type="text"
                value={excludeLinkedinInput}
                onChange={(e) => setExcludeLinkedinInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const raw = (e.target as HTMLInputElement).value.trim();
                    if (!raw) return;
                    const parts = raw.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                    const normalized = parts.map(normalizeExcludeLinkedinUrl).filter((u): u is string => u != null);
                    setExcludeLinkedinUrls((prev) => [...new Set([...prev, ...normalized])]);
                    setExcludeLinkedinInput('');
                    showExcludeReminderToast();
                  }
                }}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text').trim();
                  if (pasted && /[\n,]/.test(pasted)) {
                    e.preventDefault();
                    const parts = pasted.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                    const normalized = parts.map(normalizeExcludeLinkedinUrl).filter((u): u is string => u != null);
                    setExcludeLinkedinUrls((prev) => [...new Set([...prev, ...normalized])]);
                    showExcludeReminderToast();
                  }
                }}
                placeholder="e.g. /in/username or https://linkedin.com/in/username"
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => {
                  const raw = excludeLinkedinInput.trim();
                  if (!raw) return;
                  const parts = raw.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
                  const normalized = parts.map(normalizeExcludeLinkedinUrl).filter((u): u is string => u != null);
                  setExcludeLinkedinUrls((prev) => [...new Set([...prev, ...normalized])]);
                  setExcludeLinkedinInput('');
                  showExcludeReminderToast();
                }}
                className="px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-md border border-indigo-200 whitespace-nowrap"
              >
                Add
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={saveExcludeInvestors}
            disabled={excludeSaving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
          >
            <UserX className="w-4 h-4" />
            {excludeSaving ? 'Saving...' : 'Save exclude list'}
          </button>
        </div>
      </section>

      {/* Owners section */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Owners</h2>
        <p className="text-sm text-gray-500 mb-4">
          Manage owners used on companies. Add, edit, or remove owners and their display colors, and choose which owner is currently active.
        </p>

        {ownersLoading ? (
          <div className="py-12 flex items-center justify-center">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-indigo-500" />
          </div>
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm mb-4">
              {!isAdding ? (
                <button
                  type="button"
                  onClick={() => setIsAdding(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg"
                >
                  <Plus className="w-4 h-4" />
                  Add owner
                </button>
              ) : (
                <div className="flex flex-wrap items-end gap-3 p-4 bg-gray-50 rounded-lg">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Elon"
                      className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Color</label>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-8 h-8 rounded-lg border border-gray-200 flex-shrink-0 shadow-inner"
                        style={{ backgroundColor: OWNER_COLOR_PRESETS[newColorIndex]?.hex ?? '#94a3b8' }}
                        aria-hidden
                      />
                      <select
                        value={newColorIndex}
                        onChange={(e) => setNewColorIndex(Number(e.target.value))}
                        className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 flex-1 min-w-[120px]"
                      >
                        {OWNER_COLOR_PRESETS.map((p, i) => (
                          <option key={i} value={i}>
                            {OWNER_PRESET_LABELS[i] ?? p.hex}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddOwner}
                    disabled={saving}
                    className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditOwner}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
              {owners.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  No owners yet. Add one above to get started.
                </div>
              ) : (
                <ul className="divide-y divide-gray-200">
                  {owners.map((owner, index) => (
                    <li key={`${owner.name}-${index}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-50">
                      {editingId === `edit-${index}` ? (
                        <>
                          <div className="flex flex-wrap items-center gap-3 flex-1">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm w-40 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                            <div className="flex items-center gap-2">
                              <span
                                className="w-7 h-7 rounded-md border border-gray-200 flex-shrink-0"
                                style={{ backgroundColor: OWNER_COLOR_PRESETS[editColorIndex]?.hex ?? '#94a3b8' }}
                                aria-hidden
                              />
                              <select
                                value={editColorIndex}
                                onChange={(e) => setEditColorIndex(Number(e.target.value))}
                                className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 min-w-[100px]"
                              >
                                {OWNER_COLOR_PRESETS.map((p, i) => (
                                  <option key={i} value={i}>
                                    {OWNER_PRESET_LABELS[i] ?? p.hex}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleUpdateOwner(index)}
                              disabled={saving}
                              className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded disabled:opacity-50"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditOwner}
                              className="px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 rounded"
                              title="Cancel"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-3">
                            <span
                              className="w-4 h-4 rounded-full flex-shrink-0"
                              style={{ backgroundColor: owner.colors?.hex ?? '#94a3b8' }}
                            />
                            <span className="font-medium text-gray-900">{owner.name}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${owner.colors?.bg ?? 'bg-gray-100'} ${owner.colors?.text ?? 'text-gray-700'}`}
                            >
                              {owner.colors?.hex ?? '—'}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            {selectedOwner === owner.name ? (
                              <button
                                type="button"
                                onClick={() => setSelectedOwner('')}
                                className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border mr-2 ${owner.colors?.bg ?? 'bg-indigo-50'} ${owner.colors?.text ?? 'text-indigo-700'} ${owner.colors?.border ?? 'border-indigo-200'}`}
                                title="This owner is active. Click to unset."
                              >
                                <Check className="w-3.5 h-3.5" />
                                Active
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setSelectedOwner(owner.name)}
                                className="text-xs font-medium px-2.5 py-1 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 mr-2"
                                title="Make this the active owner"
                              >
                                Set active
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => startEditOwner(index)}
                              className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                              title="Edit"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteOwner(index)}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      {/* Account section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Account</h2>
        <div className="space-y-4">
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
        </div>
      </section>

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
                <input
                  id="newPassword"
                  type="password"
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
                <input
                  id="confirmPassword"
                  type="password"
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
