// src/context/AuthContext.tsx
import React, {
  createContext,
  useState,
  useEffect,
  ReactNode,
  useContext,
} from "react";
import api from "../lib/api";

interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (
    displayName: string,
    email: string,
    password: string
  ) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(
    localStorage.getItem("token")
  );
  const [user, setUser] = useState<User | null>(null);

  const fetchUser = async (jwt: string) => {
    try {
      const res = await api.get<User>("/auth/me", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      setUser(res.data);
    } catch {
      logout();
    }
  };

  const login = async (email: string, password: string) => {
    const res = await api.post<{ access_token: string }>("/auth/login", {
      email,
      password,
    });
    const { access_token } = res.data;
    localStorage.setItem("token", access_token);
    setToken(access_token);
    await fetchUser(access_token);
  };

  const register = async (
    displayName: string,
    email: string,
    password: string
  ) => {
    const res = await api.post<{ access_token: string }>("/auth/signup", {
      display_name: displayName,
      email,
      password,
    });
    const { access_token } = res.data;
    localStorage.setItem("token", access_token);
    setToken(access_token);
    await fetchUser(access_token);
  };

  const logout = () => {
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
  };

  useEffect(() => {
    if (token) fetchUser(token);
  }, [token]);

  return (
    <AuthContext.Provider value={{ token, user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
