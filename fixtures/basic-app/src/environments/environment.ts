export interface Environment {
  name: string;
  production: boolean;
}

export const environment: Environment = {
  name: 'development',
  production: false,
};
