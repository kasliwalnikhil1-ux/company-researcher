"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  usePhoneInput,
  FlagImage,
  defaultCountries,
  parseCountry,
} from "react-international-phone";
import { ChevronDown, Search } from "lucide-react";

interface PhoneInputFieldProps {
  value: string;
  onChange: (phone: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  placeholder?: string;
  defaultCountry?: string;
  /** Use compact height for inline/table editing */
  compact?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const parsedCountries = defaultCountries.map((c) => parseCountry(c));

const PhoneInputField: React.FC<PhoneInputFieldProps> = ({
  value,
  onChange,
  onKeyDown,
  onBlur,
  placeholder = "Enter phone number",
  defaultCountry = "in",
  compact = false,
  autoFocus = false,
  className = "",
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { inputValue, phone, country, setCountry, handlePhoneValueChange, inputRef } =
    usePhoneInput({
      defaultCountry,
      value,
      onChange: (data) => {
        onChange(data.phone);
      },
    });

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus, inputRef]);

  useEffect(() => {
    if (dropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [dropdownOpen]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const filteredCountries = search.trim()
    ? parsedCountries.filter((c) => {
        const q = search.toLowerCase();
        return (
          c.name.toLowerCase().includes(q) ||
          c.dialCode.includes(q) ||
          c.iso2.toLowerCase().includes(q) ||
          `+${c.dialCode}`.includes(q)
        );
      })
    : parsedCountries;

  const handleCountrySelect = useCallback(
    (iso2: string) => {
      const newCountry = parsedCountries.find((c) => c.iso2 === iso2);
      if (!newCountry) return;

      // Extract the local number (everything after current dial code)
      let localDigits = "";
      const currentPrefix = `+${country.dialCode}`;
      if (phone.startsWith(currentPrefix)) {
        localDigits = phone.slice(currentPrefix.length);
      }

      // Build new phone with the selected country's dial code + preserved local digits
      const newPhone = `+${newCountry.dialCode}${localDigits}`;
      onChange(newPhone);

      setDropdownOpen(false);
      setSearch("");
      // Re-focus the input after selection
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [country.dialCode, phone, onChange, inputRef]
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // Don't fire blur if focus moves within our container (e.g. to the dropdown)
      if (containerRef.current?.contains(e.relatedTarget as Node)) return;
      onBlur?.();
    },
    [onBlur]
  );

  const inputHeight = compact ? "py-1" : "py-2";
  const containerHeight = compact ? "h-[34px]" : "h-[42px]";

  return (
    <div ref={containerRef} className={`relative ${className}`} onBlur={handleBlur}>
      <div
        className={`flex items-stretch border border-gray-300 rounded-md shadow-sm overflow-visible focus-within:ring-1 focus-within:ring-indigo-500 focus-within:border-indigo-500 bg-white ${containerHeight}`}
      >
        {/* Country selector button */}
        <button
          type="button"
          onClick={() => {
            setDropdownOpen((prev) => !prev);
            setSearch("");
          }}
          className="flex items-center gap-1 px-2 border-r border-gray-300 hover:bg-gray-50 transition-colors flex-shrink-0 rounded-l-md"
        >
          <FlagImage iso2={country.iso2} size="20px" />
          <span className="text-sm text-gray-700 font-medium">+{country.dialCode}</span>
          <ChevronDown className="w-3 h-3 text-gray-400" />
        </button>

        {/* Phone number input */}
        <input
          ref={inputRef}
          type="tel"
          value={inputValue}
          onChange={handlePhoneValueChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`flex-1 min-w-0 px-3 ${inputHeight} text-sm border-0 outline-none focus:ring-0 bg-transparent`}
        />
      </div>

      {/* Country dropdown */}
      {dropdownOpen && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-[9999] overflow-hidden"
        >
          {/* Search bar */}
          <div className="p-2 border-b border-gray-100">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded-md border border-gray-200">
              <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search country or code..."
                className="flex-1 text-sm bg-transparent outline-none placeholder-gray-400"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setDropdownOpen(false);
                    setSearch("");
                    inputRef.current?.focus();
                  }
                  if (e.key === "Enter" && filteredCountries.length === 1) {
                    handleCountrySelect(filteredCountries[0].iso2);
                  }
                }}
              />
            </div>
          </div>

          {/* Country list */}
          <div className="max-h-56 overflow-y-auto">
            {filteredCountries.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">No countries found</div>
            ) : (
              filteredCountries.map((c) => (
                <button
                  key={c.iso2}
                  type="button"
                  onClick={() => handleCountrySelect(c.iso2)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-indigo-50 transition-colors text-left ${
                    c.iso2 === country.iso2 ? "bg-indigo-50 font-medium" : ""
                  }`}
                >
                  <FlagImage iso2={c.iso2} size="20px" />
                  <span className="flex-1 truncate text-gray-900">{c.name}</span>
                  <span className="text-gray-400 flex-shrink-0">+{c.dialCode}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PhoneInputField;
