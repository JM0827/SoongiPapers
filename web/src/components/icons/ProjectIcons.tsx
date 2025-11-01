import React from "react";

interface IconProps {
  size?: number;
  className?: string;
}

export const NewProjectIcon: React.FC<IconProps> = ({
  size = 16,
  className = "",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    {/* Folder base - made slightly wider */}
    <path
      d="M3 6C3 4.89543 3.89543 4 5 4H9.5L11.5 6H19C20.1046 6 21 6.89543 21 8V18C21 19.1046 20.1046 20 19 20H5C3.89543 20 3 19.1046 3 18V6Z"
      stroke="#000000"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    {/* Plus sign - adjusted for wider folder */}
    <path
      d="M11.5 9V15M8.5 12H14.5"
      stroke="#000000"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {/* Small sparkle/star for newness - repositioned */}
    <path
      d="M18 4L19 2L20 4L22 5L20 6L19 8L18 6L16 5L18 4Z"
      stroke="#000000"
      strokeWidth="1"
      fill="#000000"
      className="opacity-60"
    />
  </svg>
);

export const FolderIcon: React.FC<IconProps> = ({
  size = 16,
  className = "",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    {/* Folder base - made wider */}
    <path
      d="M2 6C2 4.89543 2.89543 4 4 4H8.5L10.5 6H20C21.1046 6 22 6.89543 22 8V18C22 19.1046 21.1046 20 20 20H4C2.89543 20 2 19.1046 2 18V6Z"
      stroke="#000000"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const OpenFolderIcon: React.FC<IconProps> = ({
  size = 16,
  className = "",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path
      d="M3 7C3 5.89543 3.89543 5 5 5H9.5L11.5 7H19C20.1046 7 21 7.89543 21 9V10"
      stroke="#1f2937"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <path
      d="M4 9H20C20.7956 9 21.5587 9.31607 22.1213 9.87868C22.6839 10.4413 23 11.2044 23 12C23 12.2139 22.9663 12.4262 22.9001 12.6284L20.9001 18.6284C20.697 19.2365 20.3034 19.7583 19.7791 20.118C19.2549 20.4777 18.6306 20.6564 18 20.625H6C5.15227 20.6277 4.34387 20.2838 3.7813 19.6762C3.21873 19.0687 2.95482 18.2538 3.05009 17.4316L3.85009 10.4316C3.92545 9.78243 4.21603 9.17752 4.67194 8.71615C5.12786 8.25478 5.7203 7.96452 6.35 7.9L9 7.7"
      stroke="#1f2937"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
