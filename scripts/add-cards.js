/**
 * Add Cards Script
 * Agrega cartones adicionales sin borrar los existentes
 *
 * Ejecutar con: node scripts/add-cards.js [cantidad]
 * Ejemplo: node scripts/add-cards.js 44
 */

import '../src/config/index.js'; // Load dotenv
import mongoose from 'mongoose';
import { connectDB } from '../src/db/connection.js';
import Card from '../src/models/Card.js';
import bingoCardService from '../src/services/bingoCard.js';

const CARDS_TO_ADD = parseInt(process.argv[2]) || 44;

async function addCards() {
  console.log('🎰 Ultra Bingo - Add Cards Script');
  console.log('==================================\n');

  try {
    // Connect to MongoDB
    console.log('📡 Conectando a MongoDB...');
    await connectDB();
    console.log('');

    // Check current state
    const beforeAvailable = await Card.countDocuments({ status: 'available' });
    const beforePurchased = await Card.countDocuments({ status: 'purchased' });
    console.log('📊 Estado actual:');
    console.log(`   • Cartones disponibles: ${beforeAvailable}`);
    console.log(`   • Cartones comprados: ${beforePurchased}`);
    console.log(`   • Total: ${beforeAvailable + beforePurchased}\n`);

    // Generate new cards
    console.log(`🎰 Generando ${CARDS_TO_ADD} cartones nuevos...`);
    const generatedCards = bingoCardService.generateMultipleCards(CARDS_TO_ADD);

    const newCards = generatedCards.map(card => ({
      cardId: card.id,
      numbers: card.numbers,
      status: 'available',
      createdAt: new Date(),
    }));

    // Insert all cards
    const insertResult = await Card.insertMany(newCards);
    console.log(`✅ Insertados: ${insertResult.length} cartones nuevos\n`);

    // Verification
    const afterAvailable = await Card.countDocuments({ status: 'available' });
    const afterPurchased = await Card.countDocuments({ status: 'purchased' });
    console.log('📊 Estado final:');
    console.log(`   • Cartones disponibles: ${afterAvailable}`);
    console.log(`   • Cartones comprados: ${afterPurchased}`);
    console.log(`   • Total: ${afterAvailable + afterPurchased}\n`);

    console.log('🎉 ¡Cartones agregados exitosamente!');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('📡 Desconectado de MongoDB');
    process.exit(0);
  }
}

addCards();
