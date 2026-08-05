// shadcn/ui 방식의 공통 버튼 컴포넌트다.

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[0.9375rem] font-semibold leading-5 transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/40 focus-visible:ring-offset-2 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-blue-600 text-white shadow-sm shadow-blue-900/10 hover:bg-blue-700 hover:shadow-md",
        decision: "bg-indigo-600 text-white shadow-sm shadow-indigo-900/10 hover:bg-indigo-700 hover:shadow-md",
        secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
        outline: "border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50",
        ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
        destructive: "bg-rose-600 text-white shadow-sm shadow-rose-900/10 hover:bg-rose-700",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 min-h-9 px-3 text-sm",
        lg: "h-12 px-5 text-base",
        icon: "size-11",
        "icon-sm": "size-9 min-h-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean;
};

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
