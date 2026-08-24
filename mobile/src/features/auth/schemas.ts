import { z } from 'zod';

import { isValidUkMobile } from '../../lib/phone';

export const TERMS_VERSION = '1.3';
export const PRIVACY_VERSION = '1.2';

const ukMobile = z
  .string()
  .min(1, 'Mobile number is required')
  .refine(isValidUkMobile, 'Enter a valid UK mobile number');

const password = z.string().min(8, 'Password must be at least 8 characters');

export const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name'),
    mobile: ukMobile,
    password,
    confirmPassword: z.string(),
    email: z.union([z.literal(''), z.string().email('Enter a valid email address')]).optional(),
    acceptTerms: z.boolean().refine((value) => value === true, {
      message: 'You must accept the Terms and Privacy Policy',
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

export type SignUpFormValues = z.infer<typeof signUpSchema>;

export const loginSchema = z.object({
  mobile: ukMobile,
  password: z.string().min(1, 'Enter your password'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  mobile: ukMobile,
});

export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

export type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;
