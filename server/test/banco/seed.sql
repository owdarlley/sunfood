-- Dados mínimos para os testes do banco rodarem num Postgres vazio (CI):
-- contas de cada papel, mesas, categorias, produtos e um pedido entregue.
-- NÃO rode no Supabase de produção.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000c001', 'ana@teste.com', '{"name":"Ana","cpf":"52998224725","birth_date":"2000-01-01"}'),
  ('00000000-0000-4000-8000-00000000c002', 'bia@teste.com', '{"name":"Bia"}'),
  ('00000000-0000-4000-8000-00000000a001', 'admin@teste.com', '{"name":"Admin"}'),
  ('00000000-0000-4000-8000-00000000a002', 'cozinha@teste.com', '{"name":"Cozinha"}'),
  ('00000000-0000-4000-8000-00000000a003', 'garcom@teste.com', '{"name":"Garçom"}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000a001';
update public.profiles set role = 'cozinha' where id = '00000000-0000-4000-8000-00000000a002';
update public.profiles set role = 'garcom' where id = '00000000-0000-4000-8000-00000000a003';

select public.set_table_count(12);

insert into public.categories (name, position, color) values
  ('Bebidas', 1, 'mar'), ('Lanches', 2, 'sol'), ('Pratos', 3, 'coral'), ('Sobremesas', 4, 'uva');

insert into public.products (id, name, category, price, stock_qty) values
  ('00000000-0000-4000-8000-00000000b001', 'Água de Coco', 'Bebidas', 8, null),
  ('00000000-0000-4000-8000-00000000b002', 'Batata Frita', 'Pratos', 25, 50),
  ('00000000-0000-4000-8000-00000000b003', 'Pastel', 'Lanches', 12, null);

select public.create_order(jsonb_build_object(
  'customerId', '00000000-0000-4000-8000-00000000c001', 'tableNumber', 1,
  'subtotal', 20, 'fee', 0, 'total', 20, 'paymentMethod', 'entrega',
  'items', jsonb_build_array(
    jsonb_build_object('productId', '00000000-0000-4000-8000-00000000b001', 'name', 'Água de Coco', 'price', 8, 'qty', 1),
    jsonb_build_object('productId', '00000000-0000-4000-8000-00000000b003', 'name', 'Pastel', 'price', 12, 'qty', 1))));
