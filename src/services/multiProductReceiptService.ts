import { supabase, cleanReceiptDataGlobal } from '../lib/supabase';
import { Receipt, ExtractedReceiptData, ReceiptScanResult } from '../types/receipt';
import { v4 as uuidv4 } from 'uuid';
import subscriptionService from './subscriptionService';
import { SubscriptionError } from '../types/subscription';

export class MultiProductReceiptService {
  
  /**
   * Save receipt data to database using single-table approach
   * For multi-product receipts, creates multiple rows with same receipt_group_id
   */
  static async saveReceipt(
    extractedData: ExtractedReceiptData,
    userId: string,
    imageUrl?: string,
    processingMethod: string = 'gpt_structured',
    ocrConfidence?: number,
    extractedText?: string
  ): Promise<ReceiptScanResult> {
    try {
      // Check usage limits before allowing receipt creation (FREEMIUM CONTROL)
      const canScan = await subscriptionService.checkCanScan(userId);
      
      if (!canScan) {
        const usageInfo = await subscriptionService.getUsageInfo(userId);
        const subscriptionError: SubscriptionError = {
          type: 'usage_limit',
          message: `Monthly limit reached! You've used ${usageInfo.receipts_used}/${usageInfo.receipts_limit} receipts. Upgrade to Premium for unlimited scanning.`,
          action: 'upgrade'
        };
        
        return {
          success: false,
          receipts: [],
          error: subscriptionError.message,
          processing_method: processingMethod as any,
          subscription_error: subscriptionError
        };
      }

      const isMultiProduct = extractedData.products && extractedData.products.length > 0;
      
      if (isMultiProduct) {
        const result = await this.saveMultiProductReceipt(
          extractedData,
          userId,
          imageUrl,
          processingMethod,
          ocrConfidence,
          extractedText
        );
        
        // Generate embeddings for all saved receipts
        if (result.success && result.receipts) {
          this.generateEmbeddingsForReceipts(result.receipts);
          
          // Increment usage count after successful receipt creation (FREEMIUM TRACKING)
          try {
            await subscriptionService.incrementUsage(userId);
          } catch (usageError) {
            console.warn('Failed to increment usage count:', usageError);
            // Don't fail the receipt creation if usage tracking fails
          }
        }
        
        return result;
      } else {
        const result = await this.saveSingleProductReceipt(
          extractedData,
          userId,
          imageUrl,
          processingMethod,
          ocrConfidence,
          extractedText
        );
        
        // Generate embedding for the saved receipt
        if (result.success && result.receipts) {
          this.generateEmbeddingsForReceipts(result.receipts);
          
          // Increment usage count after successful receipt creation (FREEMIUM TRACKING)
          try {
            await subscriptionService.incrementUsage(userId);
          } catch (usageError) {
            console.warn('Failed to increment usage count:', usageError);
            // Don't fail the receipt creation if usage tracking fails
          }
        }
        
        return result;
      }
    } catch (error: any) {
      console.error('Error saving receipt:', error);
      return {
        success: false,
        receipts: [],
        error: error.message || 'Failed to save receipt',
        processing_method: processingMethod as any
      };
    }
  }

  /**
   * Save single-product receipt (existing logic)
   */
  private static async saveSingleProductReceipt(
    extractedData: ExtractedReceiptData,
    userId: string,
    imageUrl?: string,
    processingMethod: string = 'gpt_structured',
    ocrConfidence?: number,
    extractedText?: string
  ): Promise<ReceiptScanResult> {
    const receiptData = {
      user_id: userId,
      product_description: extractedData.product_description || 'Receipt Item',
      brand_name: extractedData.brand_name || 'Unknown Brand',
      store_name: extractedData.store_name,
      purchase_location: extractedData.purchase_location,
      purchase_date: extractedData.purchase_date,
      amount: extractedData.amount,
      receipt_total: extractedData.amount, // Same as amount for single product
      warranty_period: extractedData.warranty_period,
      extended_warranty: extractedData.extended_warranty,
      model_number: extractedData.model_number,
      country: extractedData.country,
      image_url: imageUrl ? imageUrl : undefined,
      image_path: imageUrl ? imageUrl : undefined,
      processing_method: processingMethod,
      ocr_confidence: ocrConfidence,
      extracted_text: extractedText,
      is_group_receipt: false
    };
    const cleaned = cleanReceiptDataGlobal(receiptData);
    console.log('📝 [saveSingleProductReceipt] Inserting into receipts:', cleaned);
    
    const { data, error } = await supabase.from('receipts').insert([cleaned]).select();
    
    if (error) {
      console.error('❌ Supabase insert error (single):', error, error.message);
      throw new Error(`Supabase error: ${JSON.stringify(error)}`);
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('No data returned from insert operation');
    }

    return { 
      receipts: data, 
      error: undefined, 
      success: true,
      processing_method: processingMethod as any
    };
  }

  /**
   * Save multi-product receipt as multiple rows with same receipt_group_id
   */
  private static async saveMultiProductReceipt(
    extractedData: ExtractedReceiptData,
    userId: string,
    imageUrl?: string,
    processingMethod: string = 'gpt_structured',
    ocrConfidence?: number,
    extractedText?: string
  ): Promise<ReceiptScanResult> {
    const receiptGroupId = uuidv4();
    const receipts: any[] = [];
    for (const product of extractedData.products!) {
      const receiptData = {
        user_id: userId,
        product_description: product.product_description,
        brand_name: product.brand_name,
        model_number: product.model_number,
        store_name: extractedData.store_name,
        purchase_location: extractedData.purchase_location,
        purchase_date: extractedData.purchase_date,
        amount: product.amount,
        receipt_total: extractedData.amount,
        warranty_period: product.warranty_period,
        extended_warranty: (product as any).extended_warranty || undefined,
        country: extractedData.country,
        image_url: imageUrl || '',
        image_path: imageUrl || '',
        processing_method: processingMethod,
        ocr_confidence: ocrConfidence,
        extracted_text: extractedText,
        receipt_group_id: receiptGroupId,
        is_group_receipt: true
      };
      const cleaned = cleanReceiptDataGlobal(receiptData);
      console.log('📝 [saveMultiProductReceipt] Inserting into receipts:', cleaned);
      receipts.push(cleaned);
    }
    const { data, error } = await supabase.from('receipts').insert(receipts).select();
    if (error || !data || !Array.isArray(data) || data.length === 0) {
      console.error('❌ Supabase insert error (multi):', error, error?.message);
      throw new Error(`Supabase error: ${JSON.stringify(error)}`);
    }
    return { 
      receipts: data, 
      error: undefined, 
      success: true,
      processing_method: processingMethod as any
    };
  }

  /**
   * Generate embeddings for receipts asynchronously (don't wait for completion)
   * Updated to use direct OpenAI API for automatic indexing
   */
  private static generateEmbeddingsForReceipts(receipts: any[]) {
    console.log(`🤖 Auto-generating embeddings for ${receipts.length} receipt(s)...`);
    
    // Run embedding generation in the background without blocking the save operation
    receipts.forEach(receipt => {
      this.generateEmbeddingForReceipt(receipt).catch(error => {
        console.warn(`⚠️ Failed to auto-generate embedding for receipt ${receipt.id}:`, error);
      });
    });
  }

  /**
   * Generate embedding for a single receipt using direct OpenAI API
   */
  private static async generateEmbeddingForReceipt(receipt: any): Promise<void> {
    try {
      // Create content for embedding
      const content = [
        receipt.product_description || '',
        receipt.brand_name || '',
        receipt.model_number || '',
        receipt.store_name || '',
        receipt.purchase_location || '',
        receipt.warranty_period || ''
      ].filter(Boolean).join(' ');

      if (!content.trim()) {
        console.warn(`Skipping embedding generation for receipt ${receipt.id} - no content`);
        return;
      }

      console.log(`🔄 Auto-generating embedding for receipt ${receipt.id}: "${content.substring(0, 50)}..."`);

      // Get OpenAI API key
      const openaiApiKey = import.meta.env.VITE_OPENAI_API_KEY;
      
      if (!openaiApiKey) {
        console.warn('OpenAI API key not configured - skipping automatic embedding generation');
        return;
      }

      // Generate embedding using direct OpenAI API call
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: content,
          dimensions: 384
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      const embedding = result.data[0].embedding;

      // Save the embedding to the database
      const { error: updateError } = await supabase
        .from('receipts')
        .update({ embedding: embedding })
        .eq('id', receipt.id);

      if (updateError) {
        throw new Error(`Database update failed: ${updateError.message}`);
      }

      console.log(`✅ Successfully auto-generated and saved embedding for receipt ${receipt.id}`);
    } catch (error) {
      console.error(`❌ Failed to auto-generate embedding for receipt ${receipt.id}:`, error);
      // Don't throw - we don't want to break receipt saving if embedding fails
    }
  }

  /**
   * Get receipts grouped by receipt_group_id for display
   */
  static async getGroupedReceipts(userId: string): Promise<any[]> {
    const { data: receipts, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // Group receipts by receipt_group_id
    const groupedReceipts: any[] = [];
    const processedGroups = new Set<string>();

    for (const receipt of receipts) {
      if (receipt.is_group_receipt && receipt.receipt_group_id) {
        // Multi-product receipt
        if (!processedGroups.has(receipt.receipt_group_id)) {
          const groupReceipts = receipts.filter(r => r.receipt_group_id === receipt.receipt_group_id);
          
          // Find the first receipt with an image_url, or use the first receipt's image_url
          const firstReceiptWithImage = groupReceipts.find(r => r.image_url && r.image_url.trim() !== '') || groupReceipts[0];
          
          // Calculate total amount from all products in the group
          const calculatedTotal = groupReceipts.reduce((sum, r) => sum + (r.amount || 0), 0);
          
          groupedReceipts.push({
            id: receipt.receipt_group_id,
            type: 'group',
            receipts: groupReceipts,
            store_name: receipt.store_name,
            purchase_date: receipt.purchase_date,
            receipt_total: calculatedTotal, // Use calculated total
            product_count: groupReceipts.length,
            image_url: firstReceiptWithImage?.image_url || null,
            created_at: receipt.created_at,
            // Add amount as the total for display consistency
            amount: calculatedTotal
          });
          processedGroups.add(receipt.receipt_group_id);
        }
      } else {
        // Single-product receipt
        groupedReceipts.push({
          ...receipt,
          type: 'single'
        });
      }
    }

    return groupedReceipts;
  }

  /**
   * Search through all receipts including multi-product ones
   */
  static async searchReceipts(userId: string, query: string): Promise<Receipt[]> {
    const { data: receipts, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('user_id', userId)
      .or(`product_description.ilike.%${query}%,brand_name.ilike.%${query}%,store_name.ilike.%${query}%,model_number.ilike.%${query}%`)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return receipts;
  }
} 