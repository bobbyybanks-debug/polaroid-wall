import LoginForm from './LoginForm';

export default async function Login({ searchParams }: PageProps<'/admin/login'>) {
  const sp = await searchParams;
  return (
    <div className="admin" style={{ display: 'block' }}>
      <div className="login"><LoginForm linkError={sp.error === 'link'} /></div>
    </div>
  );
}
