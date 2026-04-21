
import 'reflect-metadata';
import {
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

// ─── ENTITY 1: User ────────────────────────────────────────────────────────

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ default: 'user' })
  role!: 'user' | 'admin';

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ─── ENTITY 2: Product ─────────────────────────────────────────────────────

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  basePrice!: number;

  @Column({ nullable: true })
  imageUrl!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

// ─── ENTITY 3: FlashSale ────────────────────────────────────────────────────

export type SaleStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';

@Index(['status', 'startTime'])
@Index(['status'])
@Entity('flash_sales')
export class FlashSale {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  productId!: string;

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'productId' })
  product!: Product;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  salePrice!: number;

  @Column({ type: 'int' })
  totalStock!: number;

  @Column({ type: 'int', default: 1 })
  maxPerUser!: number;

  @Column({ type: 'timestamptz' })
  startTime!: Date;

  @Column({ type: 'timestamptz' })
  endTime!: Date;

  @Column({ default: 'scheduled' })
  status!: SaleStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ─── ENTITY 4: Order ────────────────────────────────────────────────────────

export type OrderStatus = 'pending' | 'confirmed' | 'failed' | 'cancelled';

@Index(['userId'])
@Index(['saleId'])
@Index(['status'])
@Index(['createdAt'])
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column()
  saleId!: string;

  @Column()
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  unitPrice!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  @Column({ default: 'pending' })
  status!: OrderStatus;

  @Column({ nullable: true })
  paymentId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ─── ENTITY 5: InventoryLog ─────────────────────────────────────────────────

@Index(['saleId'])
@Entity('inventory_log')
export class InventoryLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  saleId!: string;

  @Column()
  productId!: string;

  @Column({ type: 'int' })
  delta!: number; // negative = sold, positive = rollback

  @Column()
  reason!: string; // 'purchase' | 'rollback' | 'admin_adjustment'

  @Column({ nullable: true })
  orderId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

// ─── DATA SOURCE ─────────────────────────────────────────────────────────────

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Supabase
  entities: [User, Product, FlashSale, Order, InventoryLog],
  synchronize: process.env.NODE_ENV === 'development', // NEVER true in production
  logging: process.env.NODE_ENV === 'development',
  poolSize: 20,
  connectTimeoutMS: 5000,
  extra: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
});