// shadcn/ui 컴포넌트의 Tailwind 클래스를 안전하게 병합한다.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
