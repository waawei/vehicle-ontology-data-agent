CREATE DATABASE IF NOT EXISTS vehicle_demo;

CREATE TABLE IF NOT EXISTS vehicle_demo.short_rental_orders
(
    order_id Nullable(String),
    business_month Nullable(String),
    organization_id String,
    supplier_name String,
    vehicle_plate Nullable(String),
    employee_name Nullable(String)
)
ENGINE = MergeTree
ORDER BY (business_month, organization_id, supplier_name, order_id);

INSERT INTO vehicle_demo.short_rental_orders VALUES
('SR-0501', '2026年05月', 'demo-hq',   '演示供应商 A', 'DEMO-A01', '演示员工 1'),
('SR-0502', '2026年05月', 'demo-hq',   '演示供应商 A', 'DEMO-A02', '演示员工 2'),
('SR-0503', '2026年05月', 'demo-east', '演示供应商 B', 'DEMO-B01', '演示员工 3'),
('SR-0504', '2026年05月', 'demo-east', '演示供应商 B', 'DEMO-B02', '演示员工 3'),
('SR-0505', '2026年05月', 'demo-west', '演示供应商 C', 'DEMO-C01', '演示员工 4'),
('SR-0506', '2026年05月', 'demo-west', '演示供应商 C', 'DEMO-C02', '演示员工 5'),
('SR-0507', '2026年05月', 'demo-west', '演示供应商 A', 'DEMO-C03', '演示员工 5'),
('SR-0508', '2026年05月', 'demo-east', '演示供应商 A', 'DEMO-B03', '演示员工 6'),
('SR-0508', '2026年05月', 'demo-east', '演示供应商 A', 'DEMO-B03', '演示员工 6'),
('SR-0601', '2026年06月', 'demo-hq',   '演示供应商 A', 'DEMO-A01', '演示员工 1'),
('SR-0602', '2026年06月', 'demo-hq',   '演示供应商 A', 'DEMO-A02', '演示员工 2'),
('SR-0603', '2026年06月', 'demo-hq',   '演示供应商 B', 'DEMO-A03', '演示员工 2'),
('SR-0604', '2026年06月', 'demo-east', '演示供应商 B', 'DEMO-B01', '演示员工 3'),
('SR-0605', '2026年06月', 'demo-east', '演示供应商 B', 'DEMO-B02', '演示员工 3'),
('SR-0606', '2026年06月', 'demo-east', '演示供应商 A', 'DEMO-B03', '演示员工 6'),
('SR-0607', '2026年06月', 'demo-west', '演示供应商 C', 'DEMO-C01', '演示员工 4'),
('SR-0608', '2026年06月', 'demo-west', '演示供应商 C', 'DEMO-C02', '演示员工 5'),
('SR-0609', '2026年06月', 'demo-west', '演示供应商 A', 'DEMO-C03', '演示员工 5'),
('SR-0610', '2026年06月', 'demo-west', '演示供应商 A', 'DEMO-C04', '演示员工 7'),
('SR-0611', '2026年06月', 'demo-east', '演示供应商 C', 'DEMO-B04', '演示员工 8'),
('SR-0611', '2026年06月', 'demo-east', '演示供应商 C', 'DEMO-B04', '演示员工 8'),
('SR-9991', '2026年06月', 'outside-scope', '范围外供应商', 'DEMO-X01', '范围外员工');

CREATE TABLE IF NOT EXISTS vehicle_demo.long_rental_monthly
(
    vehicle_id Nullable(String),
    business_month String,
    organization_id String,
    supplier_name String
)
ENGINE = MergeTree
ORDER BY (business_month, organization_id, supplier_name, vehicle_id);

INSERT INTO vehicle_demo.long_rental_monthly VALUES
('LR-001', '2026-05', 'demo-hq',   '演示供应商 A'),
('LR-002', '2026-05', 'demo-east', '演示供应商 A'),
('LR-003', '2026-05', 'demo-east', '演示供应商 B'),
('LR-004', '2026-05', 'demo-west', '演示供应商 B'),
('LR-005', '2026-05', 'demo-west', '演示供应商 C'),
('LR-006', '2026-05', 'demo-hq',   '演示供应商 C'),
('LR-001', '2026-06', 'demo-hq',   '演示供应商 A'),
('LR-002', '2026-06', 'demo-east', '演示供应商 A'),
('LR-003', '2026-06', 'demo-east', '演示供应商 B'),
('LR-004', '2026-06', 'demo-west', '演示供应商 B'),
('LR-005', '2026-06', 'demo-west', '演示供应商 C'),
('LR-006', '2026-06', 'demo-hq',   '演示供应商 C'),
('LR-007', '2026-06', 'demo-east', '演示供应商 A'),
('LR-999', '2026-06', 'outside-scope', '范围外供应商');
