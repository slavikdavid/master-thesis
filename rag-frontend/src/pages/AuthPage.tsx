// src/pages/AuthPage.tsx
import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";

import { Button } from "../components/ui/button";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "../components/ui/form";
import { Input } from "../components/ui/input";

// types for forms
type LoginFormValues = {
  email: string;
  password: string;
};

type SignupFormValues = {
  displayName: string;
  email: string;
  password: string;
};

export default function AuthPage() {
  const { login, register: doRegister } = useAuth();
  const navigate = useNavigate();

  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  // login form
  const loginForm = useForm<LoginFormValues>({
    defaultValues: { email: "", password: "" },
  });

  const onLoginSubmit = async (values: LoginFormValues) => {
    try {
      await login(values.email, values.password);
      setIsLoginOpen(false);
      navigate("/");
    } catch (err: any) {
      loginForm.setError("root", { message: err.message || "Login failed" });
    }
  };

  // signup form
  const signupForm = useForm<SignupFormValues>({
    defaultValues: { displayName: "", email: "", password: "" },
  });

  const onSignupSubmit = async (values: SignupFormValues) => {
    try {
      await doRegister(values.displayName, values.email, values.password);
      setIsSignupOpen(false);
      navigate("/");
    } catch (err: any) {
      signupForm.setError("root", {
        message: err.message || "Registration failed",
      });
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4 space-y-6">
      <h1 className="text-3xl font-semibold text-center">
        byte
        <span className="tracking-tight font-bold text-indigo-600">sophos</span>
      </h1>
      <div className="space-x-4">
        <Dialog open={isLoginOpen} onOpenChange={setIsLoginOpen}>
          <DialogTrigger asChild>
            <Button>Login</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Login</DialogTitle>
              <DialogDescription>
                Enter your credentials to access your account.
              </DialogDescription>
            </DialogHeader>
            <Form {...loginForm}>
              <form
                onSubmit={loginForm.handleSubmit(onLoginSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={loginForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="you@example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={loginForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="********"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {loginForm.formState.errors.root && (
                  <p className="text-sm text-red-600">
                    {loginForm.formState.errors.root.message}
                  </p>
                )}
                <Button type="submit" className="w-full">
                  Sign In
                </Button>
              </form>
            </Form>
            <DialogFooter>
              <Button
                variant="link"
                onClick={() => {
                  setIsLoginOpen(false);
                  setIsSignupOpen(true);
                }}
              >
                Don&apos;t have an account? Sign Up
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* signup modal */}
        <Dialog open={isSignupOpen} onOpenChange={setIsSignupOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">Sign Up</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Register</DialogTitle>
              <DialogDescription>
                Create a new account to get started.
              </DialogDescription>
            </DialogHeader>
            <Form {...signupForm}>
              <form
                onSubmit={signupForm.handleSubmit(onSignupSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={signupForm.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Your Name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={signupForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="you@example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={signupForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="********"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {signupForm.formState.errors.root && (
                  <p className="text-sm text-red-600">
                    {signupForm.formState.errors.root.message}
                  </p>
                )}
                <Button type="submit" className="w-full">
                  Create Account
                </Button>
              </form>
            </Form>
            <DialogFooter>
              <Button
                variant="link"
                onClick={() => {
                  setIsSignupOpen(false);
                  setIsLoginOpen(true);
                }}
              >
                Already have an account? Sign In
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
