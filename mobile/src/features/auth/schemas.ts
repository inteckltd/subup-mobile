import { z } from 'zod';

import { isValidUkMobile } from '../../lib/phone';

export const TERMS_VERSION = '1.0';
export const PRIVACY_VERSION = '1.0';

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
