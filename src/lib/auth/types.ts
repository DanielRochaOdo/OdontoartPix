export type Role = "administrador" | "operador" | "visualizador";

export type AuthProfile = {
  id: string;
  nome: string;
  email: string;
  role: Role;
  ativo: boolean;
};
